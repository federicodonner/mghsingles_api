// Route file for store-side (superuser) operations
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import { Prisma } from "@prisma/client";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";

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
        const cardInDb = byId.get(Number(soldCard.id));
        const saleQuantity = parseInt(soldCard.saleQuantity, 10);

        await tx.sale.create({
          data: {
            collectionid: cardInDb.collectionid,
            scryfallid: cardInDb.scryfallid,
            price: Number(soldCard.price),
            percent: cardInDb.collection?.percent ?? 0,
            quantity: saleQuantity,
            date: today,
            conditionid: cardInDb.conditionid,
            languageid: cardInDb.languageid,
            // The card table tracks printing as a `variant` string; the sale
            // table still records a boolean.
            foil: cardInDb.variant === "foil",
          },
        });

        // Modify the stock of the card
        if (saleQuantity === cardInDb.quantity) {
          await tx.cardposition.deleteMany({ where: { cardid: cardInDb.id } });
          await tx.card.delete({ where: { id: cardInDb.id } });
        } else {
          await tx.card.update({
            where: { id: cardInDb.id },
            data: { quantity: cardInDb.quantity - saleQuantity },
          });
        }
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
        select: { collectionid: true, price: true, percent: true },
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

    // NOTE: sales and commission deliberately sum `price` without multiplying
    // by `quantity`, matching the behaviour of the SQL this replaced. If
    // `price` is per-unit rather than a line total, this under-reports.
    const totals = new Map();
    for (const sale of sales) {
      const entry =
        totals.get(sale.collectionid) ?? { sales: ZERO, commission: ZERO };
      entry.sales = entry.sales.add(sale.price);
      entry.commission = entry.commission.add(sale.price.mul(sale.percent));
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

export default router;
