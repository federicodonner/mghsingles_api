// Route file for store-side (superuser) operations
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import { Prisma } from "@prisma/client";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import recordSale, { recordWithdrawal } from "../services/sales.js";
import { applyReferencePrices } from "../services/pricing.js";
import {
  describeLocation,
  sortLocations,
  LOCATION_INCLUDE,
} from "../services/locations.js";
import { matches as matchesWishlist } from "./wishlist.js";
import {
  releaseExpiredOrders,
  reservedByCard,
  refileOrder,
  refileInstructions,
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

    const today = nowSeconds();
    await prisma.$transaction(async (tx) => {
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
            date: today,
            placementIds,
          });
        }
      }
      await tx.order.update({
        where: { id },
        data: { status: "completed", closed: today },
      });
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
      await refileOrder(tx, id);
      await tx.order.update({
        where: { id },
        data: { status: "cancelled", closed: nowSeconds() },
      });
    });

    return res.status(200).json({ message: messages.ORDER_CANCELLED, refile });
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
        cardid: match.cardid,
        name: match.card?.cardgeneral?.name ?? null,
        cardsetcode: match.card?.cardgeneral?.cardsetcode ?? null,
        image: match.card?.cardgeneral?.image ?? null,
        variant: match.card?.variant ?? null,
        condition: match.card?.cardcondition?.name ?? null,
        language: match.card?.cardlanguage?.name ?? null,
        price: match.card?.price ?? null,
        available: match.card?.quantity ?? 0,
        // Every copy's whereabouts, nearest-to-hand first. A copy already in
        // someone else's bag is flagged rather than hidden, so the shop is not
        // sent looking for it in a pocket it has left.
        locations: sortLocations(
          (match.card?.cardplacement ?? []).map(describeLocation)
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

    const match = await prisma.wishlistmatch.findUnique({
      where: { id },
      include: {
        card: { include: { cardgeneral: { select: { name: true, cardsetcode: true } } } },
      },
    });
    if (!match || match.resolved) {
      return res.status(404).json({ message: messages.MATCH_NOT_FOUND });
    }

    await releaseExpiredOrders(prisma);

    // Is the card still actually free to give away?
    const reserved = await reservedByCard(prisma, [match.cardid]);
    const available = Math.max(
      0,
      (match.card?.quantity ?? 0) - (reserved.get(match.cardid) ?? 0)
    );
    if (available < 1) {
      return res.status(400).json({ message: messages.ORDER_NOT_ENOUGH_STOCK });
    }

    await prisma.$transaction(async (tx) => {
      // One open bag per customer; anything already set aside joins it.
      let bag = await tx.order.findFirst({
        where: { playerid: match.playerid, status: "pending" },
        orderBy: { created: "asc" },
      });
      if (!bag) {
        bag = await tx.order.create({
          data: {
            playerid: match.playerid,
            status: "pending",
            created: nowSeconds(),
            expires: expiryFromNow(),
          },
        });
      }

      // A withdrawal is the customer's own card, so it is priced at zero:
      // nothing is owed for taking it home.
      const price = match.kind === "withdrawal" ? 0 : match.card?.price ?? 0;

      const line = await tx.orderline.findFirst({
        where: { orderid: bag.id, cardid: match.cardid },
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
            cardid: match.cardid,
            quantity: 1,
            price,
            kind: match.kind,
          },
        });
        lineId = created.id;
      }

      // The card physically moves into the bag, but its placement is KEPT and
      // attached to the line instead of being deleted: it is the only record
      // of where the copy belongs, and a cancelled order has to be refiled.
      // Views of container contents exclude bagged placements, so the card
      // still stops showing as being in the pocket.
      //
      // The caller may name the copy they actually took; otherwise take the
      // first not already in a bag.
      const wanted = req.body.placementid
        ? await tx.cardplacement.findFirst({
            where: {
              id: parseInt(req.body.placementid, 10),
              cardid: match.cardid,
              orderlineid: null,
            },
          })
        : await tx.cardplacement.findFirst({
            where: { cardid: match.cardid, orderlineid: null },
            orderBy: [{ page: "asc" }, { pocket: "asc" }, { sequence: "asc" }, { id: "asc" }],
          });
      if (wanted) {
        await tx.cardplacement.update({
          where: { id: wanted.id },
          data: { orderlineid: lineId },
        });
      }

      // The wish has been answered.
      await tx.wishlist.delete({ where: { id: match.wishlistid } });

      // Tell the customer. Fired here rather than when the match was found:
      // until the card is actually pulled it could still be sold at the
      // counter, and promising it first would be a lie some of the time.
      await tx.notification.create({
        data: {
          playerid: match.playerid,
          kind:
            match.kind === "withdrawal"
              ? "wishlist_withdrawal_ready"
              : "wishlist_purchase_ready",
          // Snapshotted: the card row disappears once the order completes.
          cardname: match.card?.cardgeneral?.name ?? null,
          cardsetcode: match.card?.cardgeneral?.cardsetcode ?? null,
          variant: match.card?.variant ?? null,
          orderid: bag.id,
          created: nowSeconds(),
        },
      });
    });

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

// The condition multipliers. CardKingdom quotes the NM price, so these are what
// turn it into a price for every other grade.
router.get(
  "/condition",
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
  [check("cardId").isNumeric()],
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

export default router;
