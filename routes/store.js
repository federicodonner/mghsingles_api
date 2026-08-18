// The public storefront: what a shopper can actually buy.
//
// Everything here searches STOCK, not the card game. A shopper looking through
// this shop should never be shown a printing the shop does not have — the old
// behaviour of listing every card in the catalogue and letting them discover
// emptiness one click at a time is worse than useless.
//
// It is also the only route file that serves people who are not logged in, so
// it never exposes who owns a card or what the shop paid for it.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import { releaseExpiredOrders } from "../services/orders.js";
import { availabilityFor, availableOf } from "../services/availability.js";

const PAGE_SIZE = 24;

// A search with no criteria at all would mean loading the whole shop, which is
// exactly what this page stopped doing. The UI never sends one; this is the
// guard for anything else that might.
const MAX_MATCHES = 600;

// Shape a stock row for the storefront. Deliberately narrower than the admin
// view: no owner, no buy price, no consignment percentage.
function flattenCard(card, reserved, offSale) {
  const { cardgeneral: general, cardcondition, cardlanguage } = card;
  return {
    id: card.id,
    scryfallid: card.scryfallid,
    name: general?.name ?? null,
    image: general?.image ?? null,
    cardsetcode: general?.cardsetcode ?? null,
    cardsetname: general?.cardsetname ?? null,
    collectornumber: general?.collectornumber ?? null,
    typeline: general?.typeline ?? null,
    color: general?.color ?? null,
    rarity: general?.rarity ?? null,
    variant: card.variant,
    condition: cardcondition?.name ?? null,
    language: cardlanguage?.name ?? null,
    price: card.price,
    quantity: card.quantity,
    reserved: reserved.get(card.id) ?? 0,
    offsale: offSale.get(card.id) ?? 0,
    available: availableOf(card, reserved, offSale),
  };
}

const CARD_INCLUDE = {
  cardgeneral: true,
  cardcondition: { select: { name: true } },
  cardlanguage: { select: { name: true } },
};

// Colour is stored as a WUBRG string, and empty means colourless — lands,
// most artifacts, Eldrazi. "C" is offered as a colour so those are findable,
// since "no colour" is a thing shoppers look for, not an absence of data.
const COLOURLESS = "C";

function colourFilter(colours) {
  const wanted = colours
    .toUpperCase()
    .split(",")
    .map((c) => c.trim())
    .filter((c) => ["W", "U", "B", "R", "G", COLOURLESS].includes(c));
  if (!wanted.length) return null;

  const terms = [];
  if (wanted.includes(COLOURLESS)) {
    terms.push({ cardgeneral: { color: null } });
    terms.push({ cardgeneral: { color: "" } });
  }
  // Any of the named colours, so picking W and U finds mono-white, mono-blue
  // and Azorius alike. Requiring all of them would make multi-select useless
  // for anyone who does not already know a card's exact identity.
  const named = wanted.filter((c) => c !== COLOURLESS);
  for (const c of named) {
    terms.push({ cardgeneral: { color: { contains: c } } });
  }
  return terms.length ? { OR: terms } : null;
}

// --------------------------------------------------------------------------

// What the shop currently has, as filter options.
//
// Built from stock rather than from the catalogue: offering all 986 sets when
// the shop holds cards from 20 of them is a list nobody can use.
router.get(
  "/filters",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    const cards = await prisma.card.findMany({
      where: { collection: { active: true }, quantity: { gt: 0 } },
      select: {
        cardgeneral: {
          select: {
            cardsetcode: true,
            cardsetname: true,
            typeline: true,
            color: true,
          },
        },
      },
    });

    const sets = new Map();
    const types = new Set();
    const colours = new Set();

    for (const { cardgeneral: g } of cards) {
      if (!g) continue;
      if (g.cardsetcode) sets.set(g.cardsetcode, g.cardsetname);
      // The primary type is the part before the em dash, minus the
      // "Legendary"/"Basic"/"Snow" supertypes — that is what a shopper means
      // by "show me creatures".
      if (g.typeline) {
        const primary = g.typeline.split("—")[0].trim();
        for (const word of primary.split(/\s+/)) {
          if (!["Legendary", "Basic", "Snow", "World", "Host"].includes(word)) {
            types.add(word);
          }
        }
      }
      if (!g.color) colours.add(COLOURLESS);
      else for (const c of g.color) colours.add(c);
    }

    return res.status(200).json({
      sets: [...sets.entries()]
        .map(([code, name]) => ({ code, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      types: [...types].sort(),
      colours: ["W", "U", "B", "R", "G", COLOURLESS].filter((c) =>
        colours.has(c)
      ),
    });
  })
);

// Search the shop's stock.
//
//   /store/search?name=bolt&colors=R&set=lea&type=Instant&page=1
//
// Every parameter is optional but at least one is required: an unfiltered
// search is a request for the entire shop, which is the thing this page no
// longer does.
router.get(
  "/search",
  [check("page").optional().isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;

    const name = (req.query.name ?? "").trim();
    const set = (req.query.set ?? "").trim();
    const type = (req.query.type ?? "").trim();
    const colours = (req.query.colors ?? "").trim();
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    if (!name && !set && !type && !colours) {
      return res.status(400).json({ message: messages.SEARCH_NEEDS_CRITERIA });
    }

    // A dead hold still occupies stock until it is released, so expire first or
    // a card can look unavailable when nobody is really holding it.
    await releaseExpiredOrders(prisma);

    const where = {
      collection: { active: true },
      quantity: { gt: 0 },
      AND: [],
    };
    if (name) {
      where.cardgeneral = { name: { contains: name, mode: "insensitive" } };
    }
    if (set) {
      where.AND.push({ cardgeneral: { cardsetcode: set.toLowerCase() } });
    }
    if (type) {
      where.AND.push({
        cardgeneral: { typeline: { contains: type, mode: "insensitive" } },
      });
    }
    const colourTerm = colourFilter(colours);
    if (colourTerm) where.AND.push(colourTerm);
    if (!where.AND.length) delete where.AND;

    const matches = await prisma.card.findMany({
      where,
      include: CARD_INCLUDE,
      take: MAX_MATCHES,
    });

    // Availability is quantity minus holds minus off-sale containers, and none
    // of those live on the card row, so it cannot be a SQL filter. The result
    // set is bounded by MAX_MATCHES, which keeps this honest: a shop with more
    // matching stock than that is told to narrow the search rather than being
    // silently served a partial page.
    const { reserved, offSale } = await availabilityFor(prisma, matches);
    const sellable = matches
      .map((card) => flattenCard(card, reserved, offSale))
      .filter((card) => card.available > 0)
      .sort(
        (a, b) =>
          (a.name ?? "").localeCompare(b.name ?? "") ||
          (a.cardsetname ?? "").localeCompare(b.cardsetname ?? "")
      );

    const start = (page - 1) * PAGE_SIZE;
    return res.status(200).json({
      numberOfCards: sellable.length,
      numberOfPages: Math.max(1, Math.ceil(sellable.length / PAGE_SIZE)),
      page,
      truncated: matches.length >= MAX_MATCHES,
      cards: sellable.slice(start, start + PAGE_SIZE),
    });
  })
);

export default router;
