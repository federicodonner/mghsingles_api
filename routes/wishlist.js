// Route file for a customer's wishlist.
//
// Mounted at /wishlist behind `authentication` (see app.js).
//
// An entry is a card NAME plus four independent constraints — version
// (printing), language, grade (condition) and finish (variant). Each constraint
// is a LIST, and an empty list means "any", so all of these are expressible:
//
//   any version, English only          -> versions [], languageids [1]
//   these three printings, any language-> versions [a,b,c], languageids []
//   any version, NM or EX, ES or EN    -> conditionids [1,2], languageids [1,2]
//   any version, foil only             -> variants ["foil"]
//
// Finish names are Scryfall's: nonfoil, foil, etched.
//
// Entries never expire.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";

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

import { DEFAULT_FINISH } from "../services/finishes.js";
import { releaseExpiredOrders } from "../services/orders.js";
import { availabilityFor, availableOf } from "../services/availability.js";
import {
  setAsideMatch,
  raisePinnedMatch,
  MatchError,
} from "../services/matches.js";

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
  // `variant` is required now, but a legacy row could still be empty; treat
  // that as an ordinary card rather than as matching nothing.
  if (
    entry.variants.length &&
    !entry.variants.includes(card.variant || DEFAULT_FINISH)
  ) {
    return false;
  }
  return true;
}

// Decorate entries with the finishes their card actually exists in.
//
// This used to also compute what was in stock for each entry, which the
// wishlist no longer shows: a wishlist is a statement of what you want, not a
// storefront, and mixing "here is what we have" into it made the two jobs one
// screen. Dropping it also removed a card scan, two groupBy queries and an
// expiry sweep from every load of this page.
//
// `availableFinishes` stays because the editor needs it — without it the finish
// filter would offer "foil" for a card that has never been printed in foil.
async function attachFinishes(prisma, entries) {
  if (!entries.length) return [];

  const printings = await prisma.cardgeneral.findMany({
    where: { name: { in: entries.map((e) => e.name), mode: "insensitive" } },
    select: { name: true, finishes: true },
  });

  const finishesByName = new Map();
  for (const printing of printings) {
    const key = printing.name.toLowerCase();
    if (!finishesByName.has(key)) finishesByName.set(key, new Set());
    const set = finishesByName.get(key);
    for (const finish of printing.finishes.length
      ? printing.finishes
      : [DEFAULT_FINISH]) {
      set.add(finish);
    }
  }

  return entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    created: entry.created,
    quantity: entry.quantity,
    versions: entry.versions,
    languageids: entry.languageids,
    conditionids: entry.conditionids,
    variants: entry.variants,
    availableFinishes: [
      ...(finishesByName.get(entry.name.toLowerCase()) ?? []),
    ],
  }));
}

// The customer's wishlist, each entry saying what satisfies it right now.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    const entries = await prisma.wishlist.findMany({
      where: { playerid: playerId },
      orderBy: { name: "asc" },
    });

    return res.status(200).json(await attachFinishes(prisma, entries));
  })
);

// Which of these stock rows are already covered by this customer's wishlist.
//
//   /wishlist/covers?cardids=12,13,14  ->  { "12": true, "13": false, ... }
//
// The storefront asks this to decide whether a tile's button offers to add the
// card or reports that it is already wanted. It has to be per STOCK ROW, not
// per name: an entry pinned to the Tenth Edition printing does not cover the
// Secret Lair one, and a button saying "already on your list" over a version
// the wishlist will never match is a lie.
//
// It runs the same `matches` the scheduled matcher uses, rather than the
// storefront reimplementing that logic — two copies of a matching rule is two
// rules, and the one the customer sees would drift from the one that actually
// sets cards aside.
router.get(
  "/covers",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    const ids = String(req.query.cardids ?? "")
      .split(",")
      .map((n) => parseInt(n, 10))
      .filter((n) => n > 0)
      .slice(0, 200);
    if (!ids.length) return res.status(200).json({});

    const [entries, cards] = await Promise.all([
      prisma.wishlist.findMany({ where: { playerid: playerId } }),
      prisma.card.findMany({
        where: { id: { in: ids } },
        include: { cardgeneral: { select: { name: true } } },
      }),
    ]);

    const byName = new Map();
    for (const entry of entries) byName.set(entry.name.toLowerCase(), entry);

    const covered = {};
    for (const card of cards) {
      const entry = byName.get((card.cardgeneral?.name ?? "").toLowerCase());
      covered[card.id] = Boolean(entry && matches(entry, card));
    }

    return res.status(200).json(covered);
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
        // Which finishes THIS printing exists in, so the picker can say so.
        finishes: true,
      },
      orderBy: [{ releasedatyear: "asc" }, { cardsetcode: "asc" }],
    });

    return res.status(200).json(versions);
  })
);

// How many copies an entry may ask for. 4 is the deck limit; wanting more of a
// single card is a conversation with the shop, not a wishlist row.
const MIN_WANTED = 1;
const MAX_WANTED = 4;

function readQuantity(value, fallback = MIN_WANTED) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_WANTED, Math.max(MIN_WANTED, n));
}

// Merge two constraint lists.
//
// An EMPTY list means "any", so it is not a neutral element: unioning [X] into
// [] would turn "any printing" into "only X", quietly narrowing an entry the
// customer had left open. Either side being empty therefore keeps it empty.
function union(current, incoming) {
  if (!current.length || !incoming.length) return [];
  const seen = new Set(current);
  return [...current, ...incoming.filter((v) => !seen.has(v))];
}

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
    // One entry per name per player, so a second add for the same card widens
    // the entry it already has rather than failing.
    //
    // The widening is per category, because that is how the constraints are
    // modelled: adding a second printing to an entry that names one grade does
    // NOT produce two exact combinations, it produces every combination of the
    // two printings and that grade. Precision holds for the first add — which
    // is the case that matters, since the matcher then sets aside exactly the
    // copy that was clicked — and degrades honestly from there.
    if (existing) {
      const merged = await prisma.wishlist.update({
        where: { id: existing.id },
        data: {
          // Asking again never reduces what you asked for.
          quantity: Math.max(
            existing.quantity,
            readQuantity(req.body.quantity, existing.quantity)
          ),
          versions: union(existing.versions, readStrings(req.body.versions)),
          languageids: union(existing.languageids, readIds(req.body.languageids)),
          conditionids: union(existing.conditionids, readIds(req.body.conditionids)),
          variants: union(existing.variants, readStrings(req.body.variants)),
        },
      });
      return res.status(200).json({ ...merged, widened: true });
    }

    const entry = await prisma.wishlist.create({
      data: {
        playerid: playerId,
        name: known.name,
        created: Math.round(Date.now() / 1000),
        quantity: readQuantity(req.body.quantity),
        versions: readStrings(req.body.versions),
        languageids: readIds(req.body.languageids),
        conditionids: readIds(req.body.conditionids),
        variants: readStrings(req.body.variants),
      },
    });

    return res.status(201).json(entry);
  })
);

// Buy a card that is on the shelf right now.
//
// The wishlist-then-matcher road exists for cards the shop does NOT have; for
// one it visibly does, waiting for the next matcher run only delays the
// obvious. So this raises the match itself and puts the copy straight into the
// customer's bag — reserved, and therefore off everyone else's inventory, in
// the same request. The pinned wishlist entry is still created first: a match
// is an answer to a wish, and the entry is what records exactly which copy was
// asked for if anything downstream has to be unwound.
router.post(
  "/buy",
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
      include: {
        cardgeneral: { select: { name: true } },
        collection: { select: { playerid: true } },
      },
    });
    if (!card || !card.cardgeneral) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    await releaseExpiredOrders(prisma);
    const { reserved, offSale } = await availabilityFor(prisma, [card]);
    if (availableOf(card, reserved, offSale) < 1) {
      return res.status(400).json({ message: messages.ORDER_NOT_ENOUGH_STOCK });
    }

    // The pinned entry and its match — exactly what the next matcher run
    // would have raised for this copy.
    const match = await raisePinnedMatch(prisma, playerId, card);

    try {
      await setAsideMatch(prisma, match.id);
    } catch (err) {
      if (err instanceof MatchError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }

    return res.status(201).json({ message: messages.CARD_RESERVED_FOR_YOU });
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
    if (req.body.variants !== undefined) {
      data.variants = readStrings(req.body.variants);
    }
    if (req.body.quantity !== undefined) {
      data.quantity = readQuantity(req.body.quantity, entry.quantity);
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
