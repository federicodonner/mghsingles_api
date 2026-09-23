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
// view: no owner, no buy price, no consignment percentage. `viewerId` (from
// optional auth) is compared to the card's collection owner so a logged-in
// customer's own consigned cards come back flagged `mine` — the storefront
// shows those as "es tuya" with a withdrawal action instead of a price. The
// owner id itself is never exposed; only the boolean about the viewer.
function flattenCard(card, reserved, offSale, viewerId) {
  const { cardgeneral: general, cardcondition, cardlanguage } = card;
  const mine =
    viewerId != null && card.collection?.playerid === viewerId;
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
    // The owner sees the price of their own card too, alongside the "es tuya"
    // flag — the price is public (every other shopper sees it), so there is
    // nothing to hide from the one person who consigned it.
    price: card.price,
    mine,
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
  collection: { select: { playerid: true } },
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
      .map((card) => flattenCard(card, reserved, offSale, req.playerId))
      // The storefront only shows what is actually for sale in the shop, so a
      // card needs a copy available (not held by an order, not filed in a
      // container that is off sale) to appear at all — that applies to the
      // viewer's OWN cards too. A copy the customer took home in one of their
      // own containers is off sale, so it must not turn up here. A card with no
      // price is not on sale yet either (the shop still has to price it); the
      // one exception is the viewer's own card that IS for sale, shown as "es
      // tuya" without a price so they can ask for it back.
      .filter(
        (card) => card.available > 0 && (card.mine || card.price != null)
      )
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

// The three dearest cards in each browsable container, for the fan of art on
// its tile. Dearest first, so the priciest is the one in front.
//
// One query for every container rather than one per container: a shop with
// forty binders is forty round trips otherwise, on a page that is pure
// decoration. Raw SQL because "top 3 per group" is a window function, which
// Prisma's query API cannot express.
//
// Only cards a shopper could actually buy are eligible — priced, approved, in
// an active collection, not in somebody's pick-up bag. A fan advertising a
// card that is not for sale is a promise the page cannot keep. Printings are
// deduplicated (DISTINCT ON): four copies of the same bomb is one picture,
// not the same picture three times.
const TOP_CARDS_PER_UNIT = 3;

async function topCardsPerUnit(prisma) {
  const rows = await prisma.$queryRaw`
    WITH best AS (
      SELECT DISTINCT ON (p.storageid, cg.scryfallid)
             p.storageid, cg.name, cg.image, c.price
        FROM cardplacement p
        JOIN card c ON c.id = p.cardid
        JOIN cardgeneral cg ON cg.scryfallid = c.scryfallid
        JOIN storage s ON s.id = p.storageid
        JOIN collection col ON col.id = c.collectionid
       WHERE p.orderlineid IS NULL
         AND s.state = 'for_sale'
         AND s.browsable = true
         AND c.approved
         AND col.active
         AND c.price IS NOT NULL
         AND cg.image IS NOT NULL
       ORDER BY p.storageid, cg.scryfallid, c.price DESC
    ), ranked AS (
      SELECT storageid, name, image,
             ROW_NUMBER() OVER (
               PARTITION BY storageid ORDER BY price DESC, name ASC
             ) AS rn
        FROM best
    )
    SELECT storageid, name, image
      FROM ranked
     WHERE rn <= ${TOP_CARDS_PER_UNIT}
     ORDER BY storageid, rn`;

  const byUnit = new Map();
  for (const row of rows) {
    const list = byUnit.get(row.storageid) ?? [];
    list.push({ name: row.name, image: row.image });
    byUnit.set(row.storageid, list);
  }
  return byUnit;
}

// The containers a shopper can leaf through, the way they would at the
// physical counter.
//
// Only `for_sale` containers: those are the ones on the shop's shelf with
// their cards on sale. Empty ones are left out — an empty binder is a
// guaranteed dead end, same reasoning as the filters above. No owner: whose
// consignment a container is has never been the storefront's business.
//
// `browsable` is the shop saying this particular container is not something to
// page through — a working set checklist, a box of bulk. Its cards are still
// on sale and still found by /store/search; only the container is not on the
// shelf to be leafed through.
router.get(
  "/units",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;
    const [units, highlights] = await Promise.all([
      prisma.storage.findMany({
        where: { state: "for_sale", browsable: true },
        include: {
          // Bagged copies are physically out of the container, so they do not
          // count toward what a browser would find in it.
          _count: {
            select: { cardplacement: { where: { orderlineid: null } } },
          },
        },
        orderBy: { name: "asc" },
      }),
      topCardsPerUnit(prisma),
    ]);

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
          // The three best cards in it, dearest first — what the card on the
          // shelf page shows instead of a number.
          topcards: highlights.get(u.id) ?? [],
          // The viewer's own container is flagged so the storefront can mark it
          // "propio" and hide prices inside it. Only the boolean leaves.
          mine: req.playerId != null && u.playerid === req.playerId,
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
    // "it exists but you can't look" would only invite probing. A container
    // the shop took off the browse shelf answers the same way — otherwise
    // hiding it from the list would only hide the link to it.
    if (!unit || unit.state !== "for_sale" || !unit.browsable) {
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
      include: { collection: { select: { active: true, playerid: true } } },
    });
    const { reserved, offSale } = await availabilityFor(prisma, cards);
    // The whole container is the viewer's own when its owner is the viewer.
    const mineUnit = req.playerId != null && unit.playerid === req.playerId;
    const info = new Map(
      cards.map((card) => {
        const mine =
          req.playerId != null && card.collection?.playerid === req.playerId;
        const sellable = card.approved && card.collection?.active;
        // Own cards show their price too (alongside "es tuya") and are always
        // offered back. Others: a card with no price is not on sale, so it
        // reads as unavailable — the shop still has to price it.
        return [
          card.id,
          {
            mine,
            price: card.price,
            available: mine
              ? 1
              : sellable && card.price != null
              ? availableOf(card, reserved, offSale)
              : 0,
          },
        ];
      })
    );

    const publicPlacement = (pl) => {
      const meta = info.get(pl.cardid) ?? {};
      return {
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
        price: meta.price ?? null,
        available: meta.available ?? 0,
        mine: Boolean(meta.mine),
      };
    };

    const shaped = {
      id: contents.id,
      name: storeName(unit),
      type: contents.type,
      cardcount: contents.cardcount,
      mine: mineUnit,
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
