// Route file for a customer's wishlist.
//
// Mounted at /wishlist behind `authentication` (see app.js).
//
// Entries are card NAMES, not printings. Someone after a Lightning Bolt
// normally means any Bolt, and matching by name is what makes the shop's
// aggregated demand list (GET /admin/wishlist) worth reading.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import {
  releaseExpiredOrders,
  reservedByCard,
  availableOf,
} from "../services/orders.js";

// For each wishlisted name, find what is actually on sale right now.
async function attachAvailability(prisma, entries) {
  if (!entries.length) return [];

  // One query per name would be N round trips; instead pull every on-sale card
  // whose name matches any wishlisted name, then bucket in memory.
  const cards = await prisma.card.findMany({
    where: {
      collection: { active: true },
      cardgeneral: {
        name: { in: entries.map((e) => e.name), mode: "insensitive" },
      },
    },
    include: {
      cardgeneral: true,
      cardcondition: { select: { name: true } },
      cardlanguage: { select: { name: true } },
    },
  });

  const reserved = await reservedByCard(
    prisma,
    cards.map((c) => c.id)
  );

  const byName = new Map();
  for (const card of cards) {
    const available = availableOf(card, reserved);
    if (available <= 0) continue;
    const key = (card.cardgeneral?.name ?? "").toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({
      cardid: card.id,
      available,
      price: card.price,
      variant: card.variant,
      name: card.cardgeneral?.name ?? null,
      cardsetcode: card.cardgeneral?.cardsetcode ?? null,
      cardsetname: card.cardgeneral?.cardsetname ?? null,
      image: card.cardgeneral?.image ?? null,
      condition: card.cardcondition?.name ?? null,
      language: card.cardlanguage?.name ?? null,
    });
  }

  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    created: entry.created,
    inStock: byName.get(entry.name.toLowerCase()) ?? [],
  }));
}

// The customer's wishlist, each entry saying what is in stock for it.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    // Availability below must not count stock held by dead reservations.
    await releaseExpiredOrders(prisma);

    const entries = await prisma.wishlist.findMany({
      where: { playerid: playerId },
      orderBy: { name: "asc" },
    });

    return res.status(200).json(await attachAvailability(prisma, entries));
  })
);

// Add a card name to the wishlist.
router.post(
  "/",
  [check("name").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const name = String(req.body.name).trim();

    // Only accept names that exist in the card database — a typo would sit on
    // the list forever, never matching anything.
    const known = await prisma.cardgeneral.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { name: true },
    });
    if (!known) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // Store Scryfall's spelling so entries collate regardless of what was typed.
    const existing = await prisma.wishlist.findFirst({
      where: { playerid: playerId, name: { equals: known.name, mode: "insensitive" } },
    });
    if (existing) {
      return res.status(400).json({ message: messages.WISHLIST_REPEAT });
    }

    const entry = await prisma.wishlist.create({
      data: {
        playerid: playerId,
        name: known.name,
        created: Math.round(Date.now() / 1000),
      },
    });

    return res.status(201).json(entry);
  })
);

// Remove an entry.
router.delete(
  "/:wishlistId",
  [check("wishlistId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const id = parseInt(req.params.wishlistId, 10);

    // Scoped to the owner so one customer cannot delete another's entry.
    const entry = await prisma.wishlist.findFirst({
      where: { id, playerid: playerId },
    });
    if (!entry) {
      return res.status(404).json({ message: messages.WISHLIST_NOT_FOUND });
    }

    await prisma.wishlist.delete({ where: { id } });
    return res.status(200).json({ message: messages.WISHLIST_REMOVED });
  })
);

export default router;
