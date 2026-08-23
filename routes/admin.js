// Route file for store-side operations.
//
// Mounted behind `authentication` + `staff` (see app.js). Routes that should
// not be delegated to a shop hand carry `owner` individually: payouts, pricing
// policy and user roles.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import { Prisma } from "@prisma/client";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import { owner } from "../middleware/authentication.js";
import recordSale, { recordWithdrawal } from "../services/sales.js";
import {
  saleNet,
  saleRemaining,
  creditFor,
  consumeCredit,
  ZERO as CREDIT_ZERO,
} from "../services/credit.js";
import { applyReferencePrices } from "../services/pricing.js";
import { exchangeRate, setExchangeRate, toPesos } from "../services/exchange.js";
import {
  describeLocation,
  sortLocations,
  LOCATION_INCLUDE,
} from "../services/locations.js";
import { matches as matchesWishlist } from "./wishlist.js";
import { availabilityFor, availableOf } from "../services/availability.js";
import { setAsideMatch, MatchError } from "../services/matches.js";
import {
  releaseExpiredOrders,
  refileOrder,
  refileInstructions,
  nowSeconds,
  expiryFromNow,
} from "../services/orders.js";

// Every consignor's money position, grouped by person — what the Pagar page
// shows. Everyone who ever sold a card or received a payment appears, debt or
// not: a settled account still answers "when did I pay them last". Owed cards
// carry their remaining net so the page can offer exact amounts; a partial
// remainder (credit consumption landed mid-sale) shows as such rather than
// pretending the card is either state.
router.get(
  "/payment/owed",
  [owner],
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    // Customers only. Owner and staff collections ARE the shop's stock (see
    // assertOwnerMayHold), so their sales are the store selling its own cards
    // — listing them here would show the store owing itself.
    const CONSIGNORS_ONLY = { collection: { player: { role: "customer" } } };

    const [sales, history] = await Promise.all([
      prisma.sale.findMany({
        where: CONSIGNORS_ONLY,
        include: {
          cardgeneral: {
            select: { name: true, image: true, cardsetcode: true, cardsetname: true },
          },
          collection: {
            select: { id: true, player: { select: { id: true, name: true } } },
          },
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      }),
      prisma.payment.findMany({
        where: CONSIGNORS_ONLY,
        include: {
          collection: {
            select: { id: true, player: { select: { id: true, name: true } } },
          },
        },
        orderBy: [{ date: "desc" }, { id: "desc" }],
      }),
    ]);

    const groups = new Map();
    const groupFor = (collectionid, playerName) => {
      if (!groups.has(collectionid)) {
        groups.set(collectionid, {
          collectionid,
          name: playerName ?? null,
          owed: CREDIT_ZERO,
          sales: [],
          payments: [],
        });
      }
      return groups.get(collectionid);
    };

    for (const sale of sales) {
      const group = groupFor(
        sale.collectionid,
        sale.collection?.player?.name
      );
      const remaining = saleRemaining(sale);
      if (remaining.lte(0)) continue;
      group.owed = group.owed.add(remaining);
      group.sales.push({
        id: sale.id,
        date: sale.date,
        name: sale.cardgeneral?.name ?? null,
        image: sale.cardgeneral?.image ?? null,
        cardsetname: sale.cardgeneral?.cardsetname ?? null,
        quantity: sale.quantity,
        total: new Prisma.Decimal(sale.price).mul(sale.quantity).toFixed(2),
        net: saleNet(sale).toFixed(2),
        remaining: remaining.toFixed(2),
        // A boundary sale partially eaten by credit use.
        partial: new Prisma.Decimal(sale.paidamount ?? 0).gt(0),
      });
    }

    // The ledger under each group: what has already been settled, newest
    // first. `kind` rides along because a credit row is not cash that changed
    // hands, and a history that hid the difference would read wrong.
    for (const payment of history) {
      const group = groupFor(
        payment.collectionid,
        payment.collection?.player?.name
      );
      group.payments.push({
        id: payment.id,
        date: payment.date,
        ammount: payment.ammount.toFixed(2),
        kind: payment.kind,
      });
    }

    return res.status(200).json(
      [...groups.values()]
        .map((group) => ({ ...group, owed: group.owed.toFixed(2) }))
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
    );
  })
);

// A player's spendable store credit — what the store owes them, sale by sale.
// The order-completion sidebar asks this before offering credit as a way to
// pay.
router.get(
  "/credit/:playerId",
  [check("playerId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const collection = await prisma.collection.findFirst({
      where: { playerid: parseInt(req.params.playerId, 10), active: true },
      select: { id: true },
    });
    if (!collection) {
      return res.status(200).json({ credit: "0.00" });
    }
    const credit = await creditFor(prisma, collection.id);
    return res.status(200).json({ credit: credit.toFixed(2) });
  })
);

// Pay the consignor for specific sold cards.
//
// The Pagar page selects sales; each is settled in full (paidamount = net)
// and one payout ledger row per collection records the cash that changed
// hands. Already-settled ids are skipped rather than paid twice.
router.post(
  "/payment",
  [owner],
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;
    const ids = Array.isArray(req.body.saleids)
      ? req.body.saleids.map((v) => parseInt(v, 10)).filter(Number.isInteger)
      : [];
    if (!ids.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    const now = nowSeconds();
    const paid = await prisma.$transaction(async (tx) => {
      const sales = await tx.sale.findMany({ where: { id: { in: ids } } });
      const byCollection = new Map();
      for (const sale of sales) {
        const remaining = saleRemaining(sale);
        if (remaining.lte(0)) continue;
        await tx.sale.update({
          where: { id: sale.id },
          data: { paidamount: saleNet(sale), paiddate: now },
        });
        byCollection.set(
          sale.collectionid,
          (byCollection.get(sale.collectionid) ?? CREDIT_ZERO).add(remaining)
        );
      }
      let total = CREDIT_ZERO;
      for (const [collectionid, ammount] of byCollection) {
        await tx.payment.create({
          data: { collectionid, ammount, kind: "payout", date: now },
        });
        total = total.add(ammount);
      }
      return total;
    });

    return res.status(200).json({
      message: messages.PAYMENT_DONE,
      paid: paid.toFixed(2),
    });
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
        role: true,
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
  owner,
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
          paidamount: true,
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
        totals.get(sale.collectionid) ??
        { sales: ZERO, commission: ZERO, outstanding: ZERO };
      const lineTotal = sale.price.mul(sale.quantity);
      entry.sales = entry.sales.add(lineTotal);
      entry.commission = entry.commission.add(lineTotal.mul(sale.percent));
      // Owed is per-sale settlement now, not sales minus lump payments: the
      // ledger records history, `paidamount` records truth.
      entry.outstanding = entry.outstanding.add(saleRemaining(sale));
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
        outstanding: t.outstanding.toFixed(2),
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
    player: order.player
      ? { id: order.player.id, name: order.player.name }
      : null,
    lines: order.orderline.map((line) => ({
      id: line.id,
      cardid: line.cardid,
      quantity: line.quantity,
      price: line.price,
      pricepesos: line.pricepesos,
      kind: line.kind,
      name: line.card?.cardgeneral?.name ?? null,
      cardsetcode: line.card?.cardgeneral?.cardsetcode ?? null,
      image: line.card?.cardgeneral?.image ?? null,
      variant: line.card?.variant ?? null,
      condition: line.card?.cardcondition?.name ?? null,
      language: line.card?.cardlanguage?.name ?? null,
    })),
    // Withdrawals are the customer's own cards going home, so they add nothing
    // to what is owed.
    total: order.orderline
      .filter((line) => line.kind !== "withdrawal")
      .reduce((sum, line) => sum + Number(line.price) * line.quantity, 0)
      .toFixed(2),
    totalpesos: totalPesosOf(order),
  };
}

// The peso total only exists when EVERY charged line carries a peso snapshot:
// a part-dollar, part-peso sum would read as the whole order and undercharge.
// Older orders (from before the rate existed) therefore show dollars only.
function totalPesosOf(order) {
  const charged = order.orderline.filter((line) => line.kind !== "withdrawal");
  if (!charged.length || charged.some((line) => line.pricepesos == null)) {
    return null;
  }
  return charged.reduce(
    (sum, line) => sum + Number(line.pricepesos) * line.quantity,
    0
  );
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
            // Which physical copies are in the bag, so the right ones are the
            // ones removed.
            cardplacement: { select: { id: true } },
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

    // Paying with store credit needs a customer to owe money to; a counter
    // bag has nobody behind it.
    const payWithCredit = req.body?.paywithcredit === true;
    if (payWithCredit && !order.playerid) {
      return res.status(400).json({ message: messages.CREDIT_NOT_YOURS });
    }

    const today = nowSeconds();
    const settlement = await prisma.$transaction(async (tx) => {
      for (const line of order.orderline) {
        const placementIds = line.cardplacement.map((pl) => pl.id);
        if (line.kind === "withdrawal") {
          // The customer's own consigned card going home. No sale row, because
          // there is no buyer and nobody to pay out — writing one would credit
          // the owner for buying their own card.
          await recordWithdrawal(tx, {
            card: line.card,
            quantity: line.quantity,
            placementIds,
          });
        } else {
          await recordSale(tx, {
            card: line.card,
            quantity: line.quantity,
            price: Number(line.price),
            // The frozen commission base (a floored rare's real price).
            baseprice: line.baseprice != null ? Number(line.baseprice) : null,
            date: today,
            placementIds,
          });
        }
      }
      await tx.order.update({
        where: { id },
        data: { status: "completed", closed: today },
      });

      // Settle as much of the bill as the buyer's credit covers — what the
      // store owes them for their own sold cards, consumed oldest first. The
      // remainder is cash across the counter, reported so the till knows what
      // to charge.
      if (!payWithCredit) return null;
      const total = order.orderline
        .filter((line) => line.kind !== "withdrawal")
        .reduce(
          (sum, line) => sum.add(new Prisma.Decimal(line.price).mul(line.quantity)),
          CREDIT_ZERO
        );
      if (total.lte(0)) return null;
      const collection = await tx.collection.findFirst({
        where: { playerid: order.playerid, active: true },
        select: { id: true },
      });
      if (!collection) return null;
      const used = await consumeCredit(tx, collection.id, total, today);
      return { creditused: used.toFixed(2), cashdue: total.sub(used).toFixed(2) };
    });

    // Nothing was charged if the whole bag was the customer's own cards going
    // home, so do not claim it was.
    const chargedForAnything = order.orderline.some(
      (line) => line.kind !== "withdrawal"
    );
    return res.status(200).json({
      message: chargedForAnything
        ? messages.ORDER_COMPLETED
        : messages.ORDER_HANDED_OVER,
      ...(settlement ?? {}),
    });
  })
);

// Take ONE card out of a pending order, leaving the rest of the bag alone.
//
// The line's copies go back on sale: their placements are unlinked (each
// still remembers its exact pocket or position), and any copy somebody had
// physically pulled lands on the refile panel so it gets walked back to its
// place. The order's total needs no bookkeeping — it is always computed from
// the lines that remain. Removing the last line cancels the order outright:
// an empty bag is not an order, it is a cancellation that went line by line.
router.delete(
  "/order/:orderId/line/:lineId",
  [check("orderId").isNumeric(), check("lineId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const orderId = parseInt(req.params.orderId, 10);
    const lineId = parseInt(req.params.lineId, 10);

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return res.status(404).json({ message: messages.ORDER_NOT_FOUND });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: messages.ORDER_NOT_PENDING });
    }
    const line = await prisma.orderline.findFirst({
      where: { id: lineId, orderid: orderId },
    });
    if (!line) {
      return res.status(404).json({ message: messages.ORDER_NOT_FOUND });
    }

    // Where the pulled copies have to go back — read before unlinking, the
    // same order of operations as a full cancellation.
    const placements = await prisma.cardplacement.findMany({
      where: { orderlineid: lineId, pulled: true },
      include: {
        storage: { select: { id: true, name: true, type: true } },
        card: {
          include: { cardgeneral: { select: { name: true, cardsetcode: true } } },
        },
      },
    });
    const refile = placements.map((pl) => ({
      placementid: pl.id,
      cardid: pl.cardid,
      name: pl.card?.cardgeneral?.name ?? null,
      cardsetcode: pl.card?.cardgeneral?.cardsetcode ?? null,
      storageid: pl.storage?.id ?? null,
      storagename: pl.storage?.name ?? null,
      storagetype: pl.storage?.type ?? null,
      page: pl.page,
      pocket: pl.pocket,
      depth: pl.depth,
      sequence: pl.sequence,
    }));

    const cancelled = await prisma.$transaction(async (tx) => {
      await tx.cardplacement.updateMany({
        where: { orderlineid: lineId, pulled: true },
        data: { needsrefile: true },
      });
      await tx.cardplacement.updateMany({
        where: { orderlineid: lineId },
        data: { orderlineid: null, pulled: false },
      });
      await tx.orderline.delete({ where: { id: lineId } });

      const remaining = await tx.orderline.count({
        where: { orderid: orderId },
      });
      if (remaining === 0) {
        await tx.order.update({
          where: { id: orderId },
          data: { status: "cancelled", closed: nowSeconds() },
        });
        return true;
      }
      return false;
    });

    return res.status(200).json({
      message: cancelled ? messages.ORDER_CANCELLED : messages.LINE_REMOVED,
      refile,
      ordercancelled: cancelled,
    });
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

    // Read the addresses before clearing them — this is the list of where each
    // card has to go back.
    const refile = await refileInstructions(prisma, id);

    await prisma.$transaction(async (tx) => {
      // Flag before unlinking: the flag is what keeps these cards on the home
      // page's refile panel until somebody has physically put them back, and
      // the where-clause needs the link that refileOrder is about to clear.
      await tx.cardplacement.updateMany({
        // Only copies somebody physically took out; an unpulled reservation
        // never left its pocket.
        where: { orderline: { orderid: id }, pulled: true },
        data: { needsrefile: true },
      });
      await refileOrder(tx, id);
      await tx.order.update({
        where: { id },
        data: { status: "cancelled", closed: nowSeconds() },
      });
    });

    return res.status(200).json({ message: messages.ORDER_CANCELLED, refile });
  })
);

// ---------------------------------------------------------------------------
// Counter sales: the bag on the till.
//
// A walk-in sale is the same lifecycle as a reservation — cards move from
// their containers into a bag, completing writes the sale rows that credit
// each card's owner, cancelling refiles — except there is no customer account
// behind it. One counter bag is open at a time; it IS the sale in progress.
// ---------------------------------------------------------------------------

async function openCounterBag(prisma) {
  return prisma.order.findFirst({
    where: { playerid: null, status: "pending" },
    include: {
      orderline: { include: ORDER_LINE_INCLUDE },
      player: { select: { id: true, name: true } },
    },
    orderBy: { created: "asc" },
  });
}

// What the till sees for a name: each stock row with its physical copies.
//
// The storefront's search answers "how many can be bought"; the till needs
// "which copy is in my hand" — the person has already pulled a card out of a
// binder, and ringing up the wrong copy leaves the shelf lying about what it
// holds. So every row carries its sellable placements (filed in a for-sale
// container, not in a bag), each with the address to match against the real
// card, and the owner so staff see whose consignment they are selling.
router.get(
  "/countersale/search",
  [check("name").trim().isLength({ min: 2 })],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const name = String(req.query.name).trim();

    await releaseExpiredOrders(prisma);

    const cards = await prisma.card.findMany({
      where: {
        approved: true,
        collection: { active: true },
        cardgeneral: { name: { contains: name, mode: "insensitive" } },
      },
      include: {
        cardgeneral: true,
        cardcondition: { select: { name: true } },
        cardlanguage: { select: { name: true } },
        collection: { select: { player: { select: { name: true } } } },
        cardplacement: {
          where: { orderlineid: null, storage: { state: "for_sale" } },
          include: LOCATION_INCLUDE,
        },
      },
      orderBy: [{ id: "asc" }],
      // The till types a name, not a category — a match this wide means the
      // query was too short to be useful anyway.
      take: 60,
    });

    const { reserved, offSale } = await availabilityFor(prisma, cards);

    return res.status(200).json({
      cards: cards
        .map((card) => ({
          id: card.id,
          name: card.cardgeneral?.name ?? null,
          image: card.cardgeneral?.image ?? null,
          cardsetcode: card.cardgeneral?.cardsetcode ?? null,
          cardsetname: card.cardgeneral?.cardsetname ?? null,
          collectornumber: card.cardgeneral?.collectornumber ?? null,
          variant: card.variant,
          condition: card.cardcondition?.name ?? null,
          language: card.cardlanguage?.name ?? null,
          owner: card.collection?.player?.name ?? null,
          price: card.price,
          available: availableOf(card, reserved, offSale),
          copies: sortLocations(card.cardplacement.map(describeLocation)),
        }))
        // A row with nothing to hand over would only offer disabled buttons.
        .filter((row) => row.available > 0 || row.copies.length > 0),
    });
  })
);

// The sale in progress, or null when the till is clear.
router.get(
  "/countersale",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;
    await releaseExpiredOrders(prisma);
    const bag = await openCounterBag(prisma);
    return res.status(200).json(bag ? describeOrder(bag) : null);
  })
);

// Ring one copy up: into the bag, off availability.
router.post(
  "/countersale/add",
  [check("cardid").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const cardid = parseInt(req.body.cardid, 10);

    await releaseExpiredOrders(prisma);

    const card = await prisma.card.findFirst({
      where: { id: cardid, approved: true, collection: { active: true } },
      include: { cardgeneral: { select: { name: true } } },
    });
    if (!card) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }
    const { reserved, offSale } = await availabilityFor(prisma, [card]);
    if (availableOf(card, reserved, offSale) < 1) {
      return res.status(400).json({ message: messages.ORDER_NOT_ENOUGH_STOCK });
    }

    await prisma.$transaction(async (tx) => {
      let bag = await tx.order.findFirst({
        where: { playerid: null, status: "pending" },
        orderBy: { created: "asc" },
      });
      if (!bag) {
        // No expiry: the bag lives exactly as long as the sale conversation.
        bag = await tx.order.create({
          data: { playerid: null, status: "pending", created: nowSeconds() },
        });
      }

      // Sold at today's price — a counter sale has no earlier quote to honour.
      const line = await tx.orderline.findFirst({
        where: { orderid: bag.id, cardid: card.id },
      });
      let lineId;
      if (line) {
        await tx.orderline.update({
          where: { id: line.id },
          data: { quantity: line.quantity + 1 },
        });
        lineId = line.id;
      } else {
        const created = await tx.orderline.create({
          data: {
            orderid: bag.id,
            cardid: card.id,
            quantity: 1,
            price: card.price ?? 0,
            pricepesos: toPesos(card.price ?? 0, await exchangeRate(tx)),
            baseprice: card.baseprice ?? null,
            kind: "purchase",
          },
        });
        lineId = created.id;
      }

      // The caller may name the copy actually pulled off the shelf; otherwise
      // take the first not already in a bag.
      const wanted = req.body.placementid
        ? await tx.cardplacement.findFirst({
            where: {
              id: parseInt(req.body.placementid, 10),
              cardid: card.id,
              orderlineid: null,
            },
          })
        : await tx.cardplacement.findFirst({
            where: { cardid: card.id, orderlineid: null },
            orderBy: [
              { page: "asc" },
              { pocket: "asc" },
              { sequence: "asc" },
              { id: "asc" },
            ],
          });
      if (wanted) {
        await tx.cardplacement.update({
          where: { id: wanted.id },
          // The till rings up a card the person is holding, so it is pulled
          // by definition.
          data: { orderlineid: lineId, pulled: true },
        });
      }
    });

    const bag = await openCounterBag(prisma);
    return res.status(201).json(describeOrder(bag));
  })
);

// ---------------------------------------------------------------------------
// The refile queue: cards out of cancelled or expired bags, physically waiting
// to be put back where their coordinates say.
// ---------------------------------------------------------------------------

router.get(
  "/refile",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;
    const placements = await prisma.cardplacement.findMany({
      where: { needsrefile: true },
      include: {
        storage: { select: { id: true, name: true, type: true } },
        card: {
          include: {
            cardgeneral: { select: { name: true, cardsetcode: true } },
          },
        },
      },
      orderBy: [{ storageid: "asc" }, { page: "asc" }, { sequence: "asc" }],
    });
    return res.status(200).json(
      placements.map((pl) => ({
        placementid: pl.id,
        cardid: pl.cardid,
        name: pl.card?.cardgeneral?.name ?? null,
        cardsetcode: pl.card?.cardgeneral?.cardsetcode ?? null,
        storageid: pl.storage?.id ?? null,
        storagename: pl.storage?.name ?? null,
        storagetype: pl.storage?.type ?? null,
        page: pl.page,
        pocket: pl.pocket,
        depth: pl.depth,
        sequence: pl.sequence,
      }))
    );
  })
);

// The cards listed are physically back in their pockets; stop showing them.
router.post(
  "/refile/done",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;
    const ids = Array.isArray(req.body.placementids)
      ? req.body.placementids.map((v) => parseInt(v, 10)).filter(Number.isInteger)
      : [];
    if (!ids.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    await prisma.cardplacement.updateMany({
      where: { id: { in: ids }, needsrefile: true },
      data: { needsrefile: false },
    });
    return res.status(200).json({ message: messages.REFILE_CLEARED });
  })
);

// Where the cards in an order belong, so a bag can be emptied back onto the
// shelves. Readable before cancelling, so the shop can see what it is in for.
router.get(
  "/order/:orderId/refile",
  [check("orderId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    return res
      .status(200)
      .json(await refileInstructions(prisma, parseInt(req.params.orderId, 10)));
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

// What customers are asking for, most-wanted first. This is the list to read
// before taking cards on consignment.
//
// "In stock" has to mean "satisfies what someone actually asked for", not
// merely "same name": two customers wanting the same card can have completely
// different version, language and grade constraints, so a shelf copy may
// satisfy one of them and neither of the others.
router.get(
  "/wishlist",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    const entries = await prisma.wishlist.findMany({
      include: { player: { select: { id: true, name: true } } },
    });
    if (!entries.length) return res.status(200).json([]);

    const names = [...new Set(entries.map((e) => e.name))];

    const cards = await prisma.card.findMany({
      where: {
        collection: { active: true },
        cardgeneral: { name: { in: names, mode: "insensitive" } },
      },
      select: {
        id: true,
        quantity: true,
        scryfallid: true,
        languageid: true,
        conditionid: true,
        cardgeneral: { select: { name: true } },
      },
    });

    const cardsByName = new Map();
    for (const card of cards) {
      const key = (card.cardgeneral?.name ?? "").toLowerCase();
      if (!cardsByName.has(key)) cardsByName.set(key, []);
      cardsByName.get(key).push(card);
    }

    const byName = new Map();
    for (const entry of entries) {
      const key = entry.name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, {
          name: entry.name,
          wanted: 0,
          wanters: [],
          unsatisfied: [],
          inStock: 0,
        });
      }
      const row = byName.get(key);
      row.wanted++;
      row.wanters.push(entry.player?.name ?? null);

      const satisfying = (cardsByName.get(key) ?? []).filter((card) =>
        matchesWishlist(entry, card)
      );
      if (satisfying.length) {
        row.inStock += satisfying.reduce((n, card) => n + card.quantity, 0);
      } else {
        // Someone wants this and nothing on the shelf fits their filters —
        // the case worth acting on.
        row.unsatisfied.push(entry.player?.name ?? null);
      }
    }

    const rows = [...byName.values()].sort(
      (a, b) => b.unsatisfied.length - a.unsatisfied.length || b.wanted - a.wanted
    );

    return res.status(200).json(rows);
  })
);

// --------------------------------------------------------------------------
// Wishlist matches and pick-up bags
// --------------------------------------------------------------------------

// Cards in stock that satisfy somebody's wishlist, grouped by customer — the
// shop's to-do list of bags to fill. Written by scripts/matchWishlists.mjs.
router.get(
  "/match",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    // How many copies of each wished-for card are already in that customer's
    // bag, so the queue can say "wants 3, one already set aside" rather than
    // leaving the shop to count.
    const baggedByPlayerAndName = new Map();
    {
      const lines = await prisma.orderline.findMany({
        where: { order: { status: "pending" } },
        include: {
          order: { select: { playerid: true } },
          card: { include: { cardgeneral: { select: { name: true } } } },
        },
      });
      for (const line of lines) {
        const key = `${line.order.playerid}:${(
          line.card?.cardgeneral?.name ?? ""
        ).toLowerCase()}`;
        baggedByPlayerAndName.set(
          key,
          (baggedByPlayerAndName.get(key) ?? 0) + line.quantity
        );
      }
    }

    const found = await prisma.wishlistmatch.findMany({
      where: { resolved: null },
      include: {
        wishlist: {
          include: { player: { select: { id: true, name: true } } },
        },
        card: {
          include: {
            cardgeneral: true,
            cardcondition: { select: { name: true } },
            cardlanguage: { select: { name: true } },
            collection: { select: { id: true, playerid: true } },
            // Where to actually go and get it.
            cardplacement: { include: LOCATION_INCLUDE },
          },
        },
      },
      orderBy: [{ playerid: "asc" }, { found: "asc" }],
    });

    // What is ACTUALLY free right now, not what was free when the match was
    // found. A match is a snapshot: between matcher runs the copies can be
    // bagged for someone else, sold at the counter, or ride their container
    // home. The queue has to say so, or it offers work that ends in "not
    // enough stock" at the shelf.
    const matchedCards = found.map((m) => m.card).filter(Boolean);
    const { reserved, offSale } = await availabilityFor(prisma, matchedCards);

    // Group by customer: the unit of work is "fill this person's bag", not
    // "act on this one card".
    const byPlayer = new Map();
    for (const match of found) {
      const player = match.wishlist?.player;
      if (!byPlayer.has(match.playerid)) {
        byPlayer.set(match.playerid, {
          playerid: match.playerid,
          name: player?.name ?? null,
          matches: [],
        });
      }
      byPlayer.get(match.playerid).matches.push({
        id: match.id,
        kind: match.kind,
        found: match.found,
        wishlistid: match.wishlistid,
        wanted: match.wishlist?.name ?? null,
        // How many they asked for, and how many are already put by.
        wantedQuantity: match.wishlist?.quantity ?? 1,
        baggedQuantity:
          baggedByPlayerAndName.get(
            `${match.playerid}:${(match.wishlist?.name ?? "").toLowerCase()}`
          ) ?? 0,
        cardid: match.cardid,
        name: match.card?.cardgeneral?.name ?? null,
        cardsetcode: match.card?.cardgeneral?.cardsetcode ?? null,
        image: match.card?.cardgeneral?.image ?? null,
        variant: match.card?.variant ?? null,
        condition: match.card?.cardcondition?.name ?? null,
        language: match.card?.cardlanguage?.name ?? null,
        price: match.card?.price ?? null,
        available: match.card
          ? availableOf(match.card, reserved, offSale)
          : 0,
        // Every copy's whereabouts, nearest-to-hand first. A copy already in
        // someone else's bag is flagged rather than hidden, so the shop is not
        // sent looking for it in a pocket it has left.
        //
        // A withdrawal is the customer taking THEIR card home, and it comes
        // out of THEIR binder or box — never out of the shop's display, where
        // an identical copy may be sitting for sale. So only the wisher's own
        // containers are offered.
        locations: sortLocations(
          (match.card?.cardplacement ?? [])
            .filter(
              (pl) =>
                match.kind !== "withdrawal" ||
                pl.storage?.playerid === match.playerid
            )
            .map(describeLocation)
        ),
      });
    }

    return res.status(200).json([...byPlayer.values()]);
  })
);

// Put a matched card in the customer's pick-up bag.
//
// The bag IS their open pending order: "awaiting pickup and payment" is
// precisely what a pending order already means, so this appends to it rather
// than inventing a parallel concept. Reserving is what takes the card out of
// everyone else's availability; stock only drops when the order completes.
//
// The wishlist entry goes away, because it has been answered.
router.post(
  "/match/:matchId/setaside",
  [check("matchId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.matchId, 10);

    try {
      // The caller may name the copy they actually took; otherwise the first
      // not already in a bag is taken. Working the queue means the card is in
      // somebody's hand right now, so it is pulled by definition.
      await setAsideMatch(prisma, id, req.body.placementid, { pulled: true });
    } catch (err) {
      if (err instanceof MatchError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }

    return res.status(200).json({ message: messages.MATCH_SET_ASIDE });
  })
);

// Not this one — leave the wishlist entry alone and stop offering this card.
router.post(
  "/match/:matchId/dismiss",
  [check("matchId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.matchId, 10);

    const match = await prisma.wishlistmatch.findUnique({ where: { id } });
    if (!match || match.resolved) {
      return res.status(404).json({ message: messages.MATCH_NOT_FOUND });
    }

    // Resolved rather than deleted, so the next matcher run does not simply
    // re-raise it.
    await prisma.wishlistmatch.update({
      where: { id },
      data: { resolved: nowSeconds(), resolution: "dismissed" },
    });
    return res.status(200).json({ message: messages.MATCH_DISMISSED });
  })
);

// How fresh the ingested data is. Cheap to call; reads only the run log.
router.get(
  "/syncstatus",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    const sources = ["cardkingdom_prices", "default_cards", "wishlist_match"];
    const runs = await Promise.all(
      sources.map((source) =>
        prisma.syncrun.findFirst({
          where: { source },
          orderBy: { started: "desc" },
        })
      )
    );

    const [pricedPrintings, totalPrintings] = await Promise.all([
      prisma.cardprice.findMany({
        where: { source: "cardkingdom" },
        distinct: ["scryfallid"],
        select: { scryfallid: true },
      }),
      prisma.cardgeneral.count(),
    ]);

    return res.status(200).json({
      runs: sources.map((source, i) => ({
        source,
        started: runs[i]?.started ?? null,
        ok: runs[i]?.ok ?? null,
        skipped: runs[i]?.skipped ?? null,
        rows: runs[i]?.cards ?? null,
        pricedate: runs[i]?.bulkupdated ?? null,
        error: runs[i]?.error ?? null,
      })),
      prices: {
        printingsPriced: pricedPrintings.length,
        printingsTotal: totalPrintings,
      },
    });
  })
);

// --------------------------------------------------------------------------
// Pricing policy
// --------------------------------------------------------------------------

// The pesos-per-dollar exchange rate, maintained by hand on the Precios page.
// Setting it only changes what is shown and what FUTURE bags snapshot; peso
// amounts already frozen on order lines keep the rate of their day.
//
// Body: { rate } — a positive number.
router.put(
  "/exchangerate",
  owner,
  asyncHandler(async (req, res) => {
    const rate = Number(req.body.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    await setExchangeRate(req.prisma, rate);
    return res.status(200).json({ rate: await exchangeRate(req.prisma) });
  })
);

// The condition multipliers. CardKingdom quotes the NM price, so these are what
// turn it into a price for every other grade.
router.get(
  "/condition",
  owner,
  asyncHandler(async (req, res) => {
    const conditions = await req.prisma.cardcondition.findMany({
      orderBy: { id: "asc" },
    });
    return res.status(200).json(conditions);
  })
);

// Update the multipliers, then reprice everything they affect.
//
// Body: { conditions: [{ id, sellmultiplier, buymultiplier }] }
router.put(
  "/condition",
  owner,
  asyncHandler(async (req, res) => {
    const rows = req.body.conditions;
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    // A multiplier above 1 would price a played card above near-mint, which is
    // always a slip rather than an intention.
    const valid = rows.every(
      (row) =>
        Number.isInteger(Number(row.id)) &&
        Number(row.sellmultiplier) >= 0 &&
        Number(row.sellmultiplier) <= 1 &&
        Number(row.buymultiplier) >= 0 &&
        Number(row.buymultiplier) <= 1
    );
    if (!valid) {
      return res.status(400).json({ message: messages.MULTIPLIER_RANGE });
    }

    const prisma = req.prisma;
    await prisma.$transaction(
      rows.map((row) =>
        prisma.cardcondition.update({
          where: { id: Number(row.id) },
          data: {
            sellmultiplier: Number(row.sellmultiplier),
            buymultiplier: Number(row.buymultiplier),
          },
        })
      )
    );

    // Changing policy is pointless if stock keeps yesterday's numbers, so this
    // reprices immediately rather than waiting for the nightly import.
    const applied = await applyReferencePrices(prisma);

    return res.status(200).json({ message: messages.MULTIPLIERS_SAVED, applied });
  })
);

// Set one card's prices by hand, and decide whether the import may move them.
//
// Body: { price, buyprice, pricelocked, buypricelocked }
// Each field is optional; omitting one leaves it untouched.
router.put(
  "/card/:cardId/price",
  [owner, check("cardId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.cardId, 10);

    const card = await prisma.card.findUnique({ where: { id } });
    if (!card) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    const now = nowSeconds();
    const data = {};

    // A price may be cleared deliberately by sending null, which is different
    // from omitting the field.
    if (req.body.price !== undefined) {
      if (req.body.price !== null && !(Number(req.body.price) >= 0)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
      data.price = req.body.price === null ? null : Number(req.body.price);
      // A hand-set price IS the real price; a stale floor base must not keep
      // deciding the consignor's share.
      data.baseprice = null;
      data.priceupdate = now;
    }
    if (req.body.buyprice !== undefined) {
      if (req.body.buyprice !== null && !(Number(req.body.buyprice) >= 0)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
      data.buyprice = req.body.buyprice === null ? null : Number(req.body.buyprice);
      data.buypriceupdate = now;
    }
    if (typeof req.body.pricelocked === "boolean") {
      data.pricelocked = req.body.pricelocked;
    }
    if (typeof req.body.buypricelocked === "boolean") {
      data.buypricelocked = req.body.buypricelocked;
    }
    if (!Object.keys(data).length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    const updated = await prisma.card.update({ where: { id }, data });

    // Unlocking is a request to rejoin the market, so put the reference price
    // back straight away rather than leaving a stale manual number until the
    // nightly run.
    const unlocked =
      (req.body.pricelocked === false && req.body.price === undefined) ||
      (req.body.buypricelocked === false && req.body.buyprice === undefined);
    if (unlocked) {
      await applyReferencePrices(prisma, { onlyCardIds: [id] });
    }

    const fresh = await prisma.card.findUnique({
      where: { id },
      select: {
        id: true,
        price: true,
        buyprice: true,
        pricelocked: true,
        buypricelocked: true,
      },
    });
    void updated;
    return res.status(200).json(fresh);
  })
);

const PIN_PRINTING_SELECT = {
  name: true,
  image: true,
  cardsetcode: true,
  cardsetname: true,
  collectornumber: true,
};

// Every fixed price. Mostly printing-level pins (the `fixedprice` table),
// which exist whether or not the version is in stock; any stock row that is
// locked WITHOUT a pin behind it (set before pins existed, or by hand in the
// database) is appended so it stays visible and resettable rather than
// becoming a lock nobody can find.
router.get(
  "/prices/fixed",
  [owner],
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    const pins = await prisma.fixedprice.findMany({
      include: { cardgeneral: { select: PIN_PRINTING_SELECT } },
      orderBy: [{ updated: "desc" }],
    });

    // How many stock rows currently carry each pin, so the page can say
    // "sin stock" on a pin that is waiting for copies to arrive.
    const counts = await prisma.card.groupBy({
      by: ["scryfallid"],
      where: {
        scryfallid: { in: pins.map((p) => p.scryfallid) },
        collection: { active: true },
      },
      _count: { _all: true },
    });
    const inStock = new Map(counts.map((c) => [c.scryfallid, c._count._all]));

    const legacy = await prisma.card.findMany({
      where: {
        collection: { active: true },
        scryfallid: { notIn: pins.map((p) => p.scryfallid) },
        OR: [{ pricelocked: true }, { buypricelocked: true }],
      },
      include: {
        cardgeneral: { select: PIN_PRINTING_SELECT },
        cardcondition: { select: { name: true } },
        cardlanguage: { select: { name: true } },
      },
      orderBy: [{ id: "asc" }],
    });

    return res.status(200).json([
      ...pins.map((pin) => ({
        kind: "version",
        scryfallid: pin.scryfallid,
        name: pin.cardgeneral?.name ?? null,
        image: pin.cardgeneral?.image ?? null,
        cardsetcode: pin.cardgeneral?.cardsetcode ?? null,
        cardsetname: pin.cardgeneral?.cardsetname ?? null,
        collectornumber: pin.cardgeneral?.collectornumber ?? null,
        price: pin.price,
        buyprice: pin.buyprice,
        pricelocked: pin.price !== null,
        buypricelocked: pin.buyprice !== null,
        instock: inStock.get(pin.scryfallid) ?? 0,
      })),
      ...legacy.map((card) => ({
        kind: "row",
        id: card.id,
        scryfallid: card.scryfallid,
        name: card.cardgeneral?.name ?? null,
        image: card.cardgeneral?.image ?? null,
        cardsetcode: card.cardgeneral?.cardsetcode ?? null,
        cardsetname: card.cardgeneral?.cardsetname ?? null,
        collectornumber: card.cardgeneral?.collectornumber ?? null,
        variant: card.variant,
        condition: card.cardcondition?.name ?? null,
        language: card.cardlanguage?.name ?? null,
        price: card.price,
        buyprice: card.buyprice,
        pricelocked: card.pricelocked,
        buypricelocked: card.buypricelocked,
      })),
    ]);
  })
);

// Fix a price by PRINTING, in stock or not.
//
// The pin is stored on the printing (`fixedprice`) and stamped onto whatever
// stock exists right now; stock that arrives later is stamped at creation
// (applyFixedPrice) and re-stamped by every price import, so fixing a price
// on an empty shelf means "when it shows up, it costs this". Sell and buy are
// independent — a side left out keeps following the market, and repeating the
// call with the other side fills the pin in rather than replacing it.
router.put(
  "/prices/fixed",
  [owner, check("scryfallid").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const scryfallid = String(req.body.scryfallid).trim();

    const printing = await prisma.cardgeneral.findUnique({
      where: { scryfallid },
      select: { scryfallid: true },
    });
    if (!printing) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    const now = nowSeconds();
    const pinData = {};
    const stampData = {};
    if (req.body.price !== undefined && req.body.price !== null) {
      if (!(Number(req.body.price) >= 0)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
      pinData.price = Number(req.body.price);
      stampData.price = pinData.price;
      stampData.pricelocked = true;
      stampData.priceupdate = now;
    }
    if (req.body.buyprice !== undefined && req.body.buyprice !== null) {
      if (!(Number(req.body.buyprice) >= 0)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
      pinData.buyprice = Number(req.body.buyprice);
      stampData.buyprice = pinData.buyprice;
      stampData.buypricelocked = true;
      stampData.buypriceupdate = now;
    }
    if (!Object.keys(pinData).length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    await prisma.fixedprice.upsert({
      where: { scryfallid },
      create: { scryfallid, ...pinData, updated: now },
      update: { ...pinData, updated: now },
    });

    const { count } = await prisma.card.updateMany({
      where: { scryfallid, collection: { active: true } },
      data: stampData,
    });

    return res.status(200).json({ updated: count });
  })
);

// Unpin a printing: the version rejoins the market. The pin goes, its stock
// rows unlock, and the reference price is put back straight away rather than
// leaving a stale manual number until the nightly run.
router.delete(
  "/prices/fixed/:scryfallid",
  [owner, check("scryfallid").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const scryfallid = String(req.params.scryfallid).trim();

    const pin = await prisma.fixedprice.findUnique({ where: { scryfallid } });
    if (!pin) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }
    // The pin goes first: applyReferencePrices re-stamps any pin it can still
    // see, so deleting after unlocking would race it back on.
    await prisma.fixedprice.delete({ where: { scryfallid } });

    const rows = await prisma.card.findMany({
      where: { scryfallid },
      select: { id: true },
    });
    if (rows.length) {
      await prisma.card.updateMany({
        where: { scryfallid },
        data: { pricelocked: false, buypricelocked: false },
      });
      await applyReferencePrices(prisma, {
        onlyCardIds: rows.map((r) => r.id),
      });
    }

    return res.status(200).json({ message: messages.PIN_REMOVED });
  })
);

// --------------------------------------------------------------------------
// User roles
// --------------------------------------------------------------------------

const ROLES = ["customer", "staff", "owner"];

// Everyone with an account, so the owner can see who has which role.
router.get(
  "/player",
  owner,
  asyncHandler(async (req, res) => {
    const players = await req.prisma.player.findMany({
      select: { id: true, username: true, name: true, email: true, role: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    });
    return res.status(200).json(players);
  })
);

// Change someone's role.
//
// There is no "create staff account" here on purpose: people register
// themselves as customers and the owner promotes them, so there is never a
// password set by one person on behalf of another.
router.put(
  "/player/:playerId/role",
  [owner, check("playerId").isNumeric(), check("role").isIn(ROLES)],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.playerId, 10);
    const role = req.body.role;

    // An owner demoting themselves would lock the door from the inside, and
    // it is never what was meant.
    if (id === req.playerId) {
      return res.status(400).json({ message: messages.ROLE_SELF });
    }

    const target = await prisma.player.findUnique({ where: { id } });
    if (!target) {
      return res.status(404).json({ message: messages.USER_NOT_FOUND });
    }

    // The shop must keep at least one owner, or nobody can grant the role back.
    if (target.role === "owner" && role !== "owner") {
      const owners = await prisma.player.count({ where: { role: "owner" } });
      if (owners <= 1) {
        return res.status(400).json({ message: messages.ROLE_LAST_OWNER });
      }
    }

    const updated = await prisma.player.update({
      where: { id },
      data: { role },
      select: { id: true, username: true, name: true, role: true },
    });
    return res.status(200).json(updated);
  })
);

// --------------------------------------------------------------------------
// Stock search, for the counter
// --------------------------------------------------------------------------

// Find stock by card name, with everything the shop needs to price or sell it.
//
// This used to be `/store/search/:name`, which the storefront also served —
// meaning an unauthenticated shopper could read the consignor's name, the
// commission percentage and the CardKingdom buylist price for every card in the
// shop. The public route now returns a narrow shape and this one, behind the
// staff gate, carries the commercially sensitive fields.
router.get(
  "/cards/search",
  [check("q").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const q = String(req.query.q).trim();

    await releaseExpiredOrders(prisma);

    const cards = await prisma.card.findMany({
      where: {
        collection: { active: true },
        cardgeneral: { name: { contains: q, mode: "insensitive" } },
      },
      include: {
        cardgeneral: {
          include: { cardprice: { where: { source: "cardkingdom" } } },
        },
        cardcondition: { select: { name: true } },
        cardlanguage: { select: { name: true } },
        collection: {
          select: { id: true, percent: true, player: { select: { name: true } } },
        },
      },
      take: 200,
    });

    const { reserved, offSale } = await availabilityFor(prisma, cards);

    const flattened = cards
      .map((card) => {
        const { cardgeneral: g, cardcondition, cardlanguage, collection } = card;
        // The CardKingdom quote for THIS printing and finish, so the shop can
        // price against a reference rather than from memory.
        const reference = (g?.cardprice ?? []).find(
          (row) => row.finish === (card.variant || "nonfoil")
        );
        return {
          id: card.id,
          scryfallid: card.scryfallid,
          cardname: g?.name ?? null,
          image: g?.image ?? null,
          cardsetcode: g?.cardsetcode ?? null,
          cardsetname: g?.cardsetname ?? null,
          typeline: g?.typeline ?? null,
          variant: card.variant,
          condition: cardcondition?.name ?? null,
          language: cardlanguage?.name ?? null,
          quantity: card.quantity,
          reserved: reserved.get(card.id) ?? 0,
          offsale: offSale.get(card.id) ?? 0,
          available: availableOf(card, reserved, offSale),
          price: card.price,
          buyprice: card.buyprice,
          pricelocked: card.pricelocked,
          buypricelocked: card.buypricelocked,
          ckretail: reference?.retail ?? null,
          ckbuylist: reference?.buylist ?? null,
          ckpricedate: reference?.pricedate ?? null,
          collection: collection?.id ?? null,
          player: collection?.player?.name ?? null,
          percent: collection?.percent ?? null,
        };
      })
      .sort((a, b) => (a.cardname ?? "").localeCompare(b.cardname ?? ""));

    if (!flattened.length) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    return res.status(200).json({
      numberOfCards: flattened.length,
      cards: flattened,
    });
  })
);

export default router;
