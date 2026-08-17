// Route file for a customer's wishlist.
//
// Mounted at /wishlist behind `authentication` (see app.js).
//
// An entry is a card NAME plus three independent constraints — version
// (printing), language and grade (condition). Each constraint is a LIST, and an
// empty list means "any", so all of these are expressible:
//
//   any version, English only          -> versions [], languageids [1]
//   these three printings, any language-> versions [a,b,c], languageids []
//   any version, NM or EX, ES or EN    -> conditionids [1,2], languageids [1,2]
//
// Entries never expire.
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

// Normalise a constraint list from the request: unique, right type, and an
// empty list always meaning "any".
function readList(value, cast) {
  if (!Array.isArray(value)) return [];
  const cleaned = value
    .map(cast)
    .filter((v) => (typeof v === "number" ? Number.isInteger(v) : Boolean(v)));
  return [...new Set(cleaned)];
}
const readIds = (v) => readList(v, (x) => parseInt(x, 10));
const readStrings = (v) => readList(v, (x) => String(x).trim());

// Does this card satisfy the entry? Each category is checked independently and
// an empty list is a wildcard.
function matches(entry, card) {
  if (entry.versions.length && !entry.versions.includes(card.scryfallid)) {
    return false;
  }
  if (entry.languageids.length && !entry.languageids.includes(card.languageid)) {
    return false;
  }
  if (
    entry.conditionids.length &&
    !entry.conditionids.includes(card.conditionid)
  ) {
    return false;
  }
  return true;
}

function describeCard(card, available) {
  return {
    cardid: card.id,
    available,
    price: card.price,
    variant: card.variant,
    scryfallid: card.scryfallid,
    name: card.cardgeneral?.name ?? null,
    cardsetcode: card.cardgeneral?.cardsetcode ?? null,
    cardsetname: card.cardgeneral?.cardsetname ?? null,
    image: card.cardgeneral?.image ?? null,
    condition: card.cardcondition?.name ?? null,
    language: card.cardlanguage?.name ?? null,
  };
}

// For each entry, the on-sale cards that satisfy its constraints.
async function attachAvailability(prisma, entries) {
  if (!entries.length) return [];

  // One query for every wishlisted name, then filter per entry in memory —
  // constraints differ per entry, so this cannot be pushed into one WHERE.
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
    const key = (card.cardgeneral?.name ?? "").toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(card);
  }

  return entries.map((entry) => {
    const candidates = byName.get(entry.name.toLowerCase()) ?? [];
    const inStock = [];
    // Cards that share the name but fail a constraint are reported separately,
    // so the customer can see the shop has one and understand why it does not
    // count — otherwise a filtered entry looks identical to no stock at all.
    let excluded = 0;
    for (const card of candidates) {
      const available = availableOf(card, reserved);
      if (available <= 0) continue;
      if (matches(entry, card)) inStock.push(describeCard(card, available));
      else excluded++;
    }
    return {
      id: entry.id,
      name: entry.name,
      created: entry.created,
      versions: entry.versions,
      languageids: entry.languageids,
      conditionids: entry.conditionids,
      inStock,
      excluded,
    };
  });
}

// The customer's wishlist, each entry saying what satisfies it right now.
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

// Every printing of a wishlisted card, for the version picker.
//
// Exact name match, unlike /card/versions/:cardName which is a substring
// search meant for the store's search box.
router.get(
  "/:wishlistId/versions",
  [check("wishlistId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;
    const id = parseInt(req.params.wishlistId, 10);

    const entry = await prisma.wishlist.findFirst({
      where: { id, playerid: playerId },
    });
    if (!entry) {
      return res.status(404).json({ message: messages.WISHLIST_NOT_FOUND });
    }

    const versions = await prisma.cardgeneral.findMany({
      where: { name: { equals: entry.name, mode: "insensitive" } },
      select: {
        scryfallid: true,
        cardsetcode: true,
        cardsetname: true,
        collectornumber: true,
        image: true,
        releasedatyear: true,
      },
      orderBy: [{ releasedatyear: "asc" }, { cardsetcode: "asc" }],
    });

    return res.status(200).json(versions);
  })
);

// Add a card name to the wishlist, optionally constrained from the start.
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
      where: {
        playerid: playerId,
        name: { equals: known.name, mode: "insensitive" },
      },
    });
    if (existing) {
      return res.status(400).json({ message: messages.WISHLIST_REPEAT });
    }

    const entry = await prisma.wishlist.create({
      data: {
        playerid: playerId,
        name: known.name,
        created: Math.round(Date.now() / 1000),
        versions: readStrings(req.body.versions),
        languageids: readIds(req.body.languageids),
        conditionids: readIds(req.body.conditionids),
      },
    });

    return res.status(201).json(entry);
  })
);

// Replace an entry's constraints.
//
// Each category is sent whole rather than patched, so clearing one back to
// "any" is just an empty list. Omitting a category leaves it untouched.
router.put(
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

    // Scoped to the owner so one customer cannot edit another's entry.
    const entry = await prisma.wishlist.findFirst({
      where: { id, playerid: playerId },
    });
    if (!entry) {
      return res.status(404).json({ message: messages.WISHLIST_NOT_FOUND });
    }

    const data = {};
    if (req.body.versions !== undefined) {
      data.versions = readStrings(req.body.versions);
    }
    if (req.body.languageids !== undefined) {
      data.languageids = readIds(req.body.languageids);
    }
    if (req.body.conditionids !== undefined) {
      data.conditionids = readIds(req.body.conditionids);
    }
    if (!Object.keys(data).length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    const updated = await prisma.wishlist.update({ where: { id }, data });
    return res.status(200).json(updated);
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

export { matches };
export default router;
