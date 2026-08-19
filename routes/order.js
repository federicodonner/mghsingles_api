// Route file for a customer's reservations.
//
// Mounted at /order behind `authentication` (see app.js).
//
// Nothing is paid here. The customer reserves, the shop holds the cards, and
// money changes hands at the counter — so an order is a promise with a
// deadline, and completing it is the shop's job (routes/admin.js).
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import {
  releaseExpiredOrders,
  refileOrder,
  expiryFromNow,
  nowSeconds,
} from "../services/orders.js";
import { availabilityFor, availableOf } from "../services/availability.js";

const LINE_INCLUDE = {
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
    player: order.player ? { id: order.player.id, name: order.player.name } : undefined,
    lines: order.orderline.map((line) => ({
      id: line.id,
      cardid: line.cardid,
      quantity: line.quantity,
      price: line.price,
      kind: line.kind,
      name: line.card?.cardgeneral?.name ?? null,
      cardsetcode: line.card?.cardgeneral?.cardsetcode ?? null,
      cardsetname: line.card?.cardgeneral?.cardsetname ?? null,
      image: line.card?.cardgeneral?.image ?? null,
      variant: line.card?.variant ?? null,
      condition: line.card?.cardcondition?.name ?? null,
      language: line.card?.cardlanguage?.name ?? null,
    })),
    // Per-unit prices, so the line total is price * quantity. Withdrawals are
    // the customer's own cards going home and are never charged for.
    total: order.orderline
      .filter((line) => line.kind !== "withdrawal")
      .reduce((sum, line) => sum + Number(line.price) * line.quantity, 0)
      .toFixed(2),
  };
}

// The customer's own orders, newest first.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    await releaseExpiredOrders(prisma);

    const orders = await prisma.order.findMany({
      where: { playerid: playerId },
      include: { orderline: { include: LINE_INCLUDE } },
      orderBy: { created: "desc" },
    });

    return res.status(200).json(orders.map(describeOrder));
  })
);

// Place a reservation.
//
// Body: { lines: [{ cardid, quantity }] }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const lines = req.body.lines;

    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const wellFormed = lines.every(
      (line) =>
        Number.isInteger(Number(line.cardid)) && Number(line.quantity) >= 1
    );
    if (!wellFormed) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    const ids = lines.map((line) => Number(line.cardid));
    if (new Set(ids).size !== ids.length) {
      return res.status(400).json({ message: messages.ORDER_REPEAT_CARDS });
    }

    // Expire stale holds first, or their stock stays invisible to this order.
    await releaseExpiredOrders(prisma);

    const cards = await prisma.card.findMany({
      where: { id: { in: ids } },
      include: {
        cardgeneral: { select: { name: true } },
        collection: { select: { active: true } },
      },
    });
    const byId = new Map(cards.map((c) => [c.id, c]));

    const missing = ids.find((id) => !byId.has(id));
    if (missing !== undefined) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // A card in an inactive collection is not on sale at all.
    const inactive = cards.find((c) => !c.collection?.active);
    if (inactive) {
      return res.status(400).json({
        message: messages.CARD_NOT_AVAILABLE,
        card: { id: inactive.id, name: inactive.cardgeneral?.name ?? null },
      });
    }

    const { reserved, offSale } = await availabilityFor(prisma, cards);
    for (const line of lines) {
      const card = byId.get(Number(line.cardid));
      const available = availableOf(card, reserved, offSale);
      if (Number(line.quantity) > available) {
        return res.status(400).json({
          message: messages.ORDER_NOT_ENOUGH_STOCK,
          card: {
            id: card.id,
            name: card.cardgeneral?.name ?? null,
            available,
          },
        });
      }
    }

    // Create the order and its lines together: a half-written order would hold
    // stock for cards the customer never sees.
    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          playerid: playerId,
          status: "pending",
          created: nowSeconds(),
          expires: expiryFromNow(),
        },
      });
      await tx.orderline.createMany({
        data: lines.map((line) => ({
          orderid: created.id,
          cardid: Number(line.cardid),
          quantity: Number(line.quantity),
          // Price is captured now, so a later reprice cannot change what was
          // quoted. Cards with no price recorded reserve at zero.
          price: byId.get(Number(line.cardid)).price ?? 0,
        })),
      });
      return tx.order.findUnique({
        where: { id: created.id },
        include: { orderline: { include: LINE_INCLUDE } },
      });
    });

    return res.status(201).json(describeOrder(order));
  })
);

// Cancel one of the customer's own pending orders.
router.delete(
  "/:orderId",
  [check("orderId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const id = parseInt(req.params.orderId, 10);

    // Scoped to the owner, so one customer cannot cancel another's order.
    const order = await prisma.order.findFirst({
      where: { id, playerid: playerId },
    });
    if (!order) {
      return res.status(404).json({ message: messages.ORDER_NOT_FOUND });
    }
    if (order.status !== "pending") {
      return res.status(400).json({ message: messages.ORDER_NOT_PENDING });
    }

    await prisma.$transaction(async (tx) => {
      // Copies somebody physically pulled are sitting in a bag on the counter
      // and land on the shop's refile panel; ones never taken out never left
      // their pocket, so unlinking them is the whole job.
      await tx.cardplacement.updateMany({
        where: { orderline: { orderid: id }, pulled: true },
        data: { needsrefile: true },
      });
      await refileOrder(tx, id);
      await tx.order.update({
        where: { id },
        data: { status: "cancelled", closed: nowSeconds() },
      });
    });

    return res.status(200).json({ message: messages.ORDER_CANCELLED });
  })
);

export default router;
