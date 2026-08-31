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
import { exchangeRate } from "../services/exchange.js";
import { readContents } from "../services/storageContents.js";
import { storeName } from "../services/locations.js";

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
    // The ids as well as the names: wishlisting from a storefront tile pins the
    // entry to THIS printing, grade, language and finish, and the constraint
    // lists are by id. Not sensitive — they are the same public reference data
    // /card/modifiers already serves.
    conditionid: card.conditionid,
    languageid: card.languageid,
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

    // String()-wrapped, not just `.trim()`: this route is unauthenticated, and
    // a query param sent as `?name[]=x` arrives as an array, so a bare
    // `.trim()` would throw a 500. Coercing first also stops a `?name[$gt]=`
    // object from ever reaching a Prisma filter as an operator — it becomes the
    // literal string "[object Object]" and matches nothing. Capped in length so
    // a multi-megabyte term cannot drive an oversized query.
    const readTerm = (v) => String(v ?? "").slice(0, 200).trim();
    const name = readTerm(req.query.name);
    const set = readTerm(req.query.set);
    const type = readTerm(req.query.type);
    const colours = readTerm(req.query.colors);
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

// The containers a shopper can leaf through, the way they would at the
// physical counter.
//
// Only `for_sale` containers: those are the ones on the shop's shelf with
// their cards on sale. Empty ones are left out — an empty binder is a
// guaranteed dead end, same reasoning as the filters above. No owner: whose
// consignment a container is has never been the storefront's business.
router.get(
  "/units",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;
    const units = await prisma.storage.findMany({
      where: { state: "for_sale" },
      include: {
        // Bagged copies are physically out of the container, so they do not
        // count toward what a browser would find in it.
        _count: {
          select: { cardplacement: { where: { orderlineid: null } } },
        },
      },
      orderBy: { name: "asc" },
    });

    return res.status(200).json(
      units
        .filter((u) => u._count.cardplacement > 0)
        .map((u) => ({
          id: u.id,
          // Shoppers see the STORE's label for the container, never the
          // owner's own name (nor the owner).
          name: storeName(u),
          type: u.type,
          cardcount: u._count.cardplacement,
        }))
    );
  })
);

// Everything inside one for-sale container, shaped like the owner's own view
// (binder pages of pockets, box lists) but flattened for shopping: every card
// carries its live price and how many copies are actually buyable, and the
// admin-side facts — owner, collection, condition, language — never leave.
router.get(
  "/units/:unitId",
  [check("unitId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.unitId, 10);

    const unit = await prisma.storage.findUnique({ where: { id } });
    // Not-for-sale answers the same 404 as nonexistent on purpose: a retired
    // container's contents are off the market, and the storefront saying
    // "it exists but you can't look" would only invite probing.
    if (!unit || unit.state !== "for_sale") {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }

    await releaseExpiredOrders(prisma);
    const contents = await readContents(prisma, unit);

    // One availability pass over every distinct card row in the container.
    const placements = [
      ...(contents.pages ?? []).flatMap((page) =>
        page ? page.pockets.flatMap((pocket) => pocket.cards) : []
      ),
      ...(contents.standby ?? []),
      ...(contents.cards ?? []),
    ];
    const ids = [...new Set(placements.map((pl) => pl.cardid))];
    const cards = await prisma.card.findMany({
      where: { id: { in: ids } },
      include: { collection: { select: { active: true } } },
    });
    const { reserved, offSale } = await availabilityFor(prisma, cards);
    const info = new Map(
      cards.map((card) => [
        card.id,
        {
          price: card.price,
          available:
            card.approved && card.collection?.active
              ? availableOf(card, reserved, offSale)
              : 0,
        },
      ])
    );

    const publicPlacement = (pl) => ({
      placementid: pl.placementid,
      cardid: pl.cardid,
      page: pl.page,
      pocket: pl.pocket,
      depth: pl.depth,
      sequence: pl.sequence,
      name: pl.name,
      cardsetcode: pl.cardsetcode,
      cardsetname: pl.cardsetname,
      image: pl.image,
      variant: pl.variant,
      price: info.get(pl.cardid)?.price ?? null,
      available: info.get(pl.cardid)?.available ?? 0,
    });

    const shaped = {
      id: contents.id,
      name: storeName(unit),
      type: contents.type,
      cardcount: contents.cardcount,
    };
    if (unit.type === "binder") {
      shaped.maxPage = contents.maxPage;
      shaped.maxSpread = contents.maxSpread;
      shaped.pages = (contents.pages ?? []).map((page) =>
        page
          ? {
              page: page.page,
              pockets: page.pockets.map((pocket) => ({
                pocket: pocket.pocket,
                cards: pocket.cards.map(publicPlacement),
              })),
            }
          : null
      );
      // Half-sorted cards are still physically in the shop and still for
      // sale; hiding them would hide sellable stock.
      shaped.standby = (contents.standby ?? []).map(publicPlacement);
    } else {
      shaped.cards = (contents.cards ?? []).map(publicPlacement);
    }
    return res.status(200).json(shaped);
  })
);

// The pesos-per-dollar rate, for showing peso prices next to dollar ones.
// Public like the rest of the storefront: the rate hangs on the shop's wall
// anyway. `null` means the shop has not configured one, and the UIs then show
// dollars only.
router.get(
  "/exchangerate",
  asyncHandler(async (req, res) => {
    return res.status(200).json({ rate: await exchangeRate(req.prisma) });
  })
);

export default router;
