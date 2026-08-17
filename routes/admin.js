// Route file for store-side (superuser) operations
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import { Prisma } from "@prisma/client";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import recordSale from "../services/sales.js";
import {
  releaseExpiredOrders,
  nowSeconds,
  expiryFromNow,
} from "../services/orders.js";

// Creates a payment
router.post(
  "/payment",
  [check("collectionId").isNumeric(), check("ammount").isFloat({ gt: 0 })],
  asyncHandler(async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    // Get the body content
    const collectionId = parseInt(req.body.collectionId, 10);
    const ammount = Number(req.body.ammount);

    // Gets prisma from middleware
    const prisma = req.prisma;

    // Verifies that the collection exists
    const collection = await prisma.collection.findUnique({
      where: { id: collectionId },
    });
    // If there are no results, return error
    if (!collection) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }

    // Store the payment in the database
    const payment = await prisma.payment.create({
      data: {
        date: Math.round(Date.now() / 1000),
        ammount,
        collectionid: collectionId,
      },
      select: { date: true, ammount: true },
    });

    res.status(201).json(payment);
  })
);

// Post a sale
router.post(
  "/sale",
  asyncHandler(async (req, res) => {
    // Gets cardId, price, quantity
    const soldCards = req.body.soldCards;

    if (!Array.isArray(soldCards) || !soldCards.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Verify that the data is correct
    const allDataCorrect = soldCards.every(
      (card) =>
        Number.isInteger(Number(card.id)) &&
        Number(card.saleQuantity) > 0 &&
        Number(card.price) >= 0
    );
    if (!allDataCorrect) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Verifies that there are no repeat ids in the array
    const ids = soldCards.map((c) => Number(c.id));
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ message: messages.SALE_REPEAT_CARDS });
    }

    // Gets prisma from middleware
    const prisma = req.prisma;

    const cardsInDb = await prisma.card.findMany({
      where: { id: { in: ids } },
      include: {
        cardgeneral: { select: { name: true } },
        collection: { select: { percent: true } },
      },
    });
    const byId = new Map(cardsInDb.map((c) => [c.id, c]));

    // Verifies that the cards exist
    const cardNotFound = soldCards.find((c) => !byId.has(Number(c.id)));
    if (cardNotFound) {
      return res
        .status(400)
        .json({ message: messages.SEARCH_NOT_FOUND, card: cardNotFound });
    }

    // Verifies that there is enough quantity of each card in the collection
    const cardWithoutEnoughStock = soldCards.find(
      (c) => Number(c.saleQuantity) > byId.get(Number(c.id)).quantity
    );
    if (cardWithoutEnoughStock) {
      const inDb = byId.get(Number(cardWithoutEnoughStock.id));
      return res.status(400).json({
        message: messages.SALE_NOT_ENOUGH_STOCK,
        card: { ...inDb, cardname: inDb.cardgeneral?.name ?? null },
      });
    }

    // If all the data is correct, process the sale. This runs in a single
    // transaction: previously each insert and stock update was a separate
    // statement, so a failure part-way through left sales recorded against
    // stock that was never decremented.
    const today = Math.round(Date.now() / 1000);
    await prisma.$transaction(async (tx) => {
      for (const soldCard of soldCards) {
        await recordSale(tx, {
          card: byId.get(Number(soldCard.id)),
          quantity: parseInt(soldCard.saleQuantity, 10),
          price: Number(soldCard.price),
          date: today,
        });
      }
    });

    return res.status(201).json({ message: messages.SALE_PROCESSED });
  })
);

// Return user's details based on the token
// Copied from playerRoute here to use the superuser middleware
router.get(
  "/me",
  asyncHandler(async (req, res) => {
    // Gets the playerId from the authentication middleware
    const playerId = req.playerId;

    // Gets prisma from middleware
    const prisma = req.prisma;

    const user = await prisma.player.findUnique({
      where: { id: playerId },
      // Explicit select rather than deleting keys afterwards — the old code
      // did `delete user.passwordHash`, which never matched the actual
      // `passwordhash` column and shipped the bcrypt hash to the client.
      select: {
        username: true,
        name: true,
        email: true,
        superuser: true,
      },
    });

    // If there are no results, return error
    if (!user) {
      return res.status(401).json({ message: messages.UNAUTHORIZED });
    }

    // If there is a user, return it
    return res.status(200).json(user);
  })
);

// Return payments and sales from collections
router.get(
  "/pendingpayments",
  asyncHandler(async (req, res) => {
    // Gets prisma from middleware
    const prisma = req.prisma;

    const [sales, payments, collections] = await Promise.all([
      prisma.sale.findMany({
        select: {
          collectionid: true,
          price: true,
          percent: true,
          quantity: true,
        },
      }),
      prisma.payment.groupBy({
        by: ["collectionid"],
        _sum: { ammount: true },
      }),
      prisma.collection.findMany({
        select: { id: true, player: { select: { name: true } } },
      }),
    ]);

    // Money is summed with Prisma's Decimal, never JS numbers — floating point
    // turns a 3002.40 commission into 3002.3999999999996.
    const { Decimal } = Prisma;
    const ZERO = new Decimal(0);

    // `sale.price` is the price of ONE card, so every line is price * quantity.
    // The SQL this replaced summed price alone and under-reported every
    // multi-copy sale.
    const totals = new Map();
    for (const sale of sales) {
      const entry =
        totals.get(sale.collectionid) ?? { sales: ZERO, commission: ZERO };
      const lineTotal = sale.price.mul(sale.quantity);
      entry.sales = entry.sales.add(lineTotal);
      entry.commission = entry.commission.add(lineTotal.mul(sale.percent));
      totals.set(sale.collectionid, entry);
    }

    const paidByCollection = new Map(
      payments.map((p) => [p.collectionid, p._sum.ammount ?? ZERO])
    );
    const nameByCollection = new Map(
      collections.map((c) => [c.id, c.player?.name ?? null])
    );

    const rows = [...totals.entries()].map(([collectionid, t]) => {
      const paid = paidByCollection.get(collectionid) ?? ZERO;
      return {
        name: nameByCollection.get(collectionid) ?? null,
        collectionid,
        sales: t.sales.toFixed(2),
        commission: t.commission.toFixed(2),
        payments: paid.toFixed(2),
        outstanding: t.sales.sub(t.commission).sub(paid).toFixed(2),
      };
    });

    return res.status(200).json(rows);
  })
);

// --------------------------------------------------------------------------
// Customer reservations
// --------------------------------------------------------------------------

const ORDER_LINE_INCLUDE = {
  card: {
    include: {
      cardgeneral: true,
      cardcondition: { select: { name: true } },
      cardlanguage: { select: { name: true } },
    },
  },
};

function describeOrder(order) {
  return {
    id: order.id,
    status: order.status,
    created: order.created,
    expires: order.expires,
    closed: order.closed,
    note: order.note,
    player: order.player
      ? { id: order.player.id, name: order.player.name }
      : null,
    lines: order.orderline.map((line) => ({
      id: line.id,
      cardid: line.cardid,
      quantity: line.quantity,
      price: line.price,
      name: line.card?.cardgeneral?.name ?? null,
      cardsetcode: line.card?.cardgeneral?.cardsetcode ?? null,
      image: line.card?.cardgeneral?.image ?? null,
      variant: line.card?.variant ?? null,
      condition: line.card?.cardcondition?.name ?? null,
      language: line.card?.cardlanguage?.name ?? null,
    })),
    total: order.orderline
      .reduce((sum, line) => sum + Number(line.price) * line.quantity, 0)
      .toFixed(2),
  };
}

// The shop's queue. `?status=` filters; pending first by default.
router.get(
  "/order",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;
    await releaseExpiredOrders(prisma);

    const where = {};
    if (typeof req.query.status === "string") where.status = req.query.status;

    const orders = await prisma.order.findMany({
      where,
      include: {
        orderline: { include: ORDER_LINE_INCLUDE },
        player: { select: { id: true, name: true } },
      },
      orderBy: [{ status: "asc" }, { created: "asc" }],
    });

    return res.status(200).json(orders.map(describeOrder));
  })
);

// The customer came in and paid.
//
// This is a real sale: it writes sale rows through the same service the counter
// uses, so the consignor is owed their share exactly as if it had been sold
// over the counter. Stock is only decremented here — a reservation never
// touched it.
router.post(
  "/order/:orderId/complete",
  [check("orderId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.orderId, 10);

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        orderline: {
          include: {
            card: {
              include: {
                cardgeneral: { select: { name: true } },
                collection: { select: { percent: true } },
              },
            },
          },
        },
      },
    });
    if (!order) {
      return res.status(404).json({ message: messages.ORDER_NOT_FOUND });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: messages.ORDER_NOT_PENDING });
    }

    // Stock can have moved since the reservation — a counter sale of the same
    // card does not know about holds. Re-check before committing.
    const short = order.orderline.find(
      (line) => !line.card || line.quantity > line.card.quantity
    );
    if (short) {
      return res.status(400).json({
        message: messages.ORDER_NOT_ENOUGH_STOCK,
        card: {
          id: short.cardid,
          name: short.card?.cardgeneral?.name ?? null,
          available: short.card?.quantity ?? 0,
        },
      });
    }

    const today = nowSeconds();
    await prisma.$transaction(async (tx) => {
      for (const line of order.orderline) {
        await recordSale(tx, {
          card: line.card,
          quantity: line.quantity,
          price: Number(line.price),
          date: today,
        });
      }
      await tx.order.update({
        where: { id },
        data: { status: "completed", closed: today },
      });
    });

    return res.status(200).json({ message: messages.ORDER_COMPLETED });
  })
);

// Cancel a reservation on the customer's behalf, releasing the stock.
router.post(
  "/order/:orderId/cancel",
  [check("orderId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.orderId, 10);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      return res.status(404).json({ message: messages.ORDER_NOT_FOUND });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: messages.ORDER_NOT_PENDING });
    }

    await prisma.order.update({
      where: { id },
      data: { status: "cancelled", closed: nowSeconds() },
    });
    return res.status(200).json({ message: messages.ORDER_CANCELLED });
  })
);

// Give a customer more time rather than making them re-reserve.
router.post(
  "/order/:orderId/extend",
  [check("orderId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.orderId, 10);

    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) {
      return res.status(404).json({ message: messages.ORDER_NOT_FOUND });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: messages.ORDER_NOT_PENDING });
    }

    const updated = await prisma.order.update({
      where: { id },
      data: { expires: expiryFromNow() },
    });
    return res.status(200).json({ expires: updated.expires });
  })
);

// --------------------------------------------------------------------------
// Wishlist demand
// --------------------------------------------------------------------------

// What customers are asking for, most-wanted first, with whether the shop can
// already supply it. This is the list to read before taking cards on
// consignment.
router.get(
  "/wishlist",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    const demand = await prisma.wishlist.groupBy({
      by: ["name"],
      _count: { name: true },
      orderBy: { _count: { name: "desc" } },
    });
    if (!demand.length) return res.status(200).json([]);

    const names = demand.map((d) => d.name);

    const [entries, cards] = await Promise.all([
      prisma.wishlist.findMany({
        where: { name: { in: names } },
        include: { player: { select: { id: true, name: true } } },
      }),
      prisma.card.findMany({
        where: {
          collection: { active: true },
          cardgeneral: { name: { in: names, mode: "insensitive" } },
        },
        select: { id: true, quantity: true, cardgeneral: { select: { name: true } } },
      }),
    ]);

    const wantersByName = new Map();
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (!wantersByName.has(key)) wantersByName.set(key, []);
      wantersByName.get(key).push(entry.player?.name ?? null);
    }
    const stockByName = new Map();
    for (const card of cards) {
      const key = (card.cardgeneral?.name ?? "").toLowerCase();
      stockByName.set(key, (stockByName.get(key) ?? 0) + card.quantity);
    }

    return res.status(200).json(
      demand.map((d) => ({
        name: d.name,
        wanted: d._count.name,
        wanters: wantersByName.get(d.name.toLowerCase()) ?? [],
        inStock: stockByName.get(d.name.toLowerCase()) ?? 0,
      }))
    );
  })
);

export default router;
