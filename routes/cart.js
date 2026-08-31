// A customer's shopping cart. Mounted at /cart behind `authentication`.
//
// The cart is the pause between wanting and asking: rows here hold NO stock
// and the shop hears nothing about them. Only confirming turns each row into
// the pinned wishlist match a storefront buy used to raise on the spot, which
// is what lands on the shop's "Cartas para apartar" queue. That also means a
// cart can go stale — somebody else may buy the copy first — so availability
// is re-checked at confirmation and reported honestly, not assumed.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import { releaseExpiredOrders, nowSeconds } from "../services/orders.js";
import { availabilityFor, availableOf } from "../services/availability.js";
import { raisePinnedMatch } from "../services/matches.js";

// The most copies of one card a cart line may hold. Confirmation loops this
// many times per line (each iteration is several DB round-trips), so it is a
// hard ceiling, not just a UX nicety — a singles buyer wanting more than this
// of one printing is a conversation with the shop, not a self-service order.
const MAX_LINE_QUANTITY = 40;

const ITEM_INCLUDE = {
  card: {
    include: {
      cardgeneral: true,
      collection: { select: { active: true } },
    },
  },
};

// Live prices, not snapshots: what the customer pays is quoted when the shop
// bags the copy (unchanged), so the cart showing anything but the current
// shelf price would be the one number guaranteed to be wrong somewhere.
function describeItem(item, reserved, offSale) {
  const card = item.card;
  const general = card?.cardgeneral;
  const buyable = Boolean(card?.approved && card?.collection?.active);
  return {
    id: item.id,
    cardid: item.cardid,
    quantity: item.quantity,
    name: general?.name ?? null,
    cardsetcode: general?.cardsetcode ?? null,
    cardsetname: general?.cardsetname ?? null,
    image: general?.image ?? null,
    variant: card?.variant ?? null,
    price: card?.price ?? null,
    available: buyable ? availableOf(card, reserved, offSale) : 0,
  };
}

async function cartWithAvailability(prisma, playerId) {
  await releaseExpiredOrders(prisma);
  const items = await prisma.cartitem.findMany({
    where: { playerid: playerId },
    include: ITEM_INCLUDE,
    orderBy: { created: "asc" },
  });
  const { reserved, offSale } = await availabilityFor(
    prisma,
    items.map((i) => i.card)
  );
  return items.map((item) => describeItem(item, reserved, offSale));
}

// What is in the cart right now, with live prices and availability so the
// page can flag a row that went out of stock before it fails at confirm.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const items = await cartWithAvailability(req.prisma, playerId);
    return res.status(200).json({
      items,
      total: items
        .reduce((sum, i) => sum + Number(i.price ?? 0) * i.quantity, 0)
        .toFixed(2),
    });
  })
);

// Add one copy of a card row. Adding the same row again bumps the quantity.
router.post(
  "/",
  [check("cardid").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const cardid = parseInt(req.body.cardid, 10);

    const card = await prisma.card.findFirst({
      where: { id: cardid, approved: true, collection: { active: true } },
    });
    if (!card) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // The cart holds no stock, but knowingly letting somebody cart a fifth
    // copy of a card with four would only move the disappointment to the
    // confirm step. Their own cart counts against the limit too.
    await releaseExpiredOrders(prisma);
    const { reserved, offSale } = await availabilityFor(prisma, [card]);
    const existing = await prisma.cartitem.findFirst({
      where: { playerid: playerId, cardid },
    });
    const inCart = existing?.quantity ?? 0;
    if (inCart + 1 > availableOf(card, reserved, offSale)) {
      return res.status(400).json({ message: messages.CART_NOT_ENOUGH_STOCK });
    }
    if (inCart + 1 > MAX_LINE_QUANTITY) {
      return res.status(400).json({ message: messages.CART_LINE_LIMIT });
    }

    const item = existing
      ? await prisma.cartitem.update({
          where: { id: existing.id },
          data: { quantity: existing.quantity + 1 },
        })
      : await prisma.cartitem.create({
          data: { playerid: playerId, cardid, created: nowSeconds() },
        });

    return res.status(201).json({
      message: messages.CART_ADDED,
      item: { id: item.id, cardid: item.cardid, quantity: item.quantity },
    });
  })
);

// Take one row out of the cart entirely.
router.delete(
  "/:itemId",
  [check("itemId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const id = parseInt(req.params.itemId, 10);

    // Scoped to the owner so one customer cannot empty another's cart.
    const item = await prisma.cartitem.findFirst({
      where: { id, playerid: playerId },
    });
    if (!item) {
      return res.status(404).json({ message: messages.CART_ITEM_NOT_FOUND });
    }
    await prisma.cartitem.delete({ where: { id } });
    return res.status(200).json({ message: messages.CART_ITEM_REMOVED });
  })
);

// Change a row's quantity. Zero is a removal — the cart page's minus button
// pressed once too often should not be an error.
router.put(
  "/:itemId",
  [
    check("itemId").isNumeric(),
    check("quantity").isInt({ min: 0, max: MAX_LINE_QUANTITY }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const id = parseInt(req.params.itemId, 10);
    const quantity = parseInt(req.body.quantity, 10);

    const item = await prisma.cartitem.findFirst({
      where: { id, playerid: playerId },
      include: ITEM_INCLUDE,
    });
    if (!item) {
      return res.status(404).json({ message: messages.CART_ITEM_NOT_FOUND });
    }

    if (quantity === 0) {
      await prisma.cartitem.delete({ where: { id } });
      return res.status(200).json({ message: messages.CART_ITEM_REMOVED });
    }

    await releaseExpiredOrders(prisma);
    const { reserved, offSale } = await availabilityFor(prisma, [item.card]);
    if (quantity > availableOf(item.card, reserved, offSale)) {
      return res.status(400).json({ message: messages.CART_NOT_ENOUGH_STOCK });
    }

    const updated = await prisma.cartitem.update({
      where: { id },
      data: { quantity },
    });
    return res.status(200).json({
      id: updated.id,
      cardid: updated.cardid,
      quantity: updated.quantity,
    });
  })
);

// Confirm the cart: ask the shop to set every card in it aside.
//
// Each confirmed copy raises exactly what a storefront buy raised before the
// cart existed — a pinned wishlist entry and its match, one bump per copy —
// so the shop's queue and everything downstream behave identically.
//
// Deliberately partial: the copies still available are confirmed, and rows
// that went out of stock since they were added STAY in the cart and are
// reported by name. Failing the whole confirm because one card sold would
// punish the customer for the shop's good day.
router.post(
  "/confirm",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    await releaseExpiredOrders(prisma);
    const items = await prisma.cartitem.findMany({
      where: { playerid: playerId },
      include: {
        card: {
          include: {
            cardgeneral: { select: { name: true } },
            collection: { select: { active: true, playerid: true } },
          },
        },
      },
      orderBy: { created: "asc" },
    });
    if (!items.length) {
      return res.status(400).json({ message: messages.CART_EMPTY });
    }

    const { reserved, offSale } = await availabilityFor(
      prisma,
      items.map((i) => i.card)
    );

    const confirmed = [];
    const unavailable = [];
    for (const item of items) {
      const card = item.card;
      const name = card?.cardgeneral?.name ?? null;
      const sellable = Boolean(card?.approved && card?.collection?.active);
      const available = sellable ? availableOf(card, reserved, offSale) : 0;
      // All or nothing PER ROW: asking the shop to pull two of three wanted
      // copies would leave a quantity silently shrunk. The row stays whole in
      // the cart and the shortage is reported instead.
      if (available < item.quantity) {
        unavailable.push({ name, wanted: item.quantity, available });
        continue;
      }
      // One raise per copy — byte-for-byte what N presses of the old instant
      // buy button did, so the wanted quantity accumulates the same way.
      for (let i = 0; i < item.quantity; i++) {
        await raisePinnedMatch(prisma, playerId, card, { bumpWanted: true });
      }
      confirmed.push({ name, quantity: item.quantity });
      await prisma.cartitem.delete({ where: { id: item.id } });
    }

    return res.status(200).json({
      message: confirmed.length ? messages.CARD_RESERVED_FOR_YOU : messages.ORDER_NOT_ENOUGH_STOCK,
      confirmed,
      unavailable,
    });
  })
);

export default router;
