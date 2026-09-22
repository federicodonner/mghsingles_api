// Route file for card operations
import { Router } from "express";
import { request } from "https";
var router = Router();
import client from "../config/db.js";
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import { authentication } from "../middleware/authentication.js";
import { FINISHES } from "../services/finishes.js";
import { quotePrintings } from "../services/pricing.js";
import { PAPER_ONLY, PAPER_SETS_ONLY } from "../services/paper.js";

async function getExternalUrl(path) {
  const options = {
    host: process.env.CARDKINGDOM_URL,
    port: 443,
    path: path,
  };
  let content = "";

  return new Promise(function (resolve, reject) {
    var req = request(options, function (res) {
      // reject on bad status
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error("statusCode=" + res.statusCode));
      }
      // cumulate data
      var body = [];
      res.on("data", function (chunk) {
        body.push(chunk);
      });
      // resolve on end
      res.on("end", function () {
        try {
          body = Buffer.concat(body).toString();
        } catch (e) {
          reject(e);
        }
        resolve(body);
      });
    });
    // reject on request error
    req.on("error", function (err) {
      // This is not a "Second reject", just a different sort of failure
      reject(err);
    });
    // IMPORTANT
    req.end();
  });
}

// Function to get the price of a single card
async function getSingleCardPrice(card) {
  // If there is not price on record, scrape it from CK and store it
  // Form the cardkingdom URL for price scrapping
  // Process set name
  // remove colons, substitue spaces with dashes
  let setName = card.cardsetname
    .replace(/\s/g, "-")
    .replace(/:/g, "")
    .toLowerCase();
  // Process card name
  // Keep only the first half it it's a split card
  // Remove commas, substitute spaces with dashes
  let cardName = card.name
    .split(" //")[0]
    .replace(/\s/g, "-")
    .replace(/,/g, "")
    .toLowerCase();

  // Format the collector number to 3 digits with leading zeros
  let collectorNumber = card.collectornumber;
  if (collectorNumber < 10) {
    collectorNumber = `00${collectorNumber}`;
  } else if (collectorNumber < 100) {
    collectorNumber = `0${collectorNumber}`;
  }

  // If the card is a box topper, that trumps other alterations
  if (card.boxtopper) {
    setName = `${setName}-box-toppers`;
  } else {
    // If the card is borderless and it's not from Secret Lair, add the tags to the URL
    if (
      card.borderless &&
      setName.indexOf("secret-lair") === -1 &&
      setName.indexOf("strixhaven-mystical-archive") === -1
    ) {
      setName = `${setName}-variants`;
      cardName = `${cardName}-borderless`;
    }

    // If the card is extended art and it's not from Secret Lair, add the tags to the URL
    if (card.extendedart && setName.indexOf("secret-lair") === -1) {
      setName = `${setName}-variants`;
      cardName = `${cardName}-extended-art`;
    }

    // If the card is in phyrexian and it's not from Secret Lair, add the tags to the URL
    if (card.phyrexian && setName.indexOf("secret-lair") === -1) {
      setName = `${setName}-variants`;
      cardName = `${cardName}-phyrexian`;
    }
  }

  // If the card is showcase and it's not from Secret Lair or mystical archive, add the tags to the URL
  if (
    card.showcase &&
    setName.indexOf("secret-lair") === -1 &&
    setName.indexOf("strixhaven-mystical-archive") === -1
  ) {
    setName = `${setName}-variants`;
    cardName = `${cardName}-showcase`;
  }

  // If the card is from a secret lair and not foil, add the tag
  if (setName.indexOf("secret-lair") !== -1 && !card.variant) {
    cardName = `${cardName}-non-foil`;
  }

  // If the request had a vriant (foil-etched), add it to the url
  if (card.variant === "foil-etched") {
    cardName = `${cardName}-${card.variant}`;
  }

  // If the card is from strixhave mystical archive japan, add some more information
  if (setName.indexOf("strixhaven-mystical-archive-jpn") !== -1) {
    cardName = `${cardName}-${collectorNumber}-jpn-alternate-art`;
  }

  // Finally, if the request had a vriant (foil), add it to the url
  if (card.variant === "foil") {
    cardName = `${cardName}-${card.variant}`;
  }

  const path = `/mtg/${setName}/${cardName}`;
  const ckurl = `https://${process.env.CARDKINGDOM_URL}${path}`;
  const ckuri = path;
  try {
    const responseWebpage = await getExternalUrl(path);

    // Return the 4 tags with the prices
    const tags = responseWebpage.match(
      /<input type="hidden" name="price" value="[\d\.]*">/g
    );
    if (!tags) {
      return {
        price: null,
        ckurl,
        ckuri,
      };
    }

    // Pick the price based on the condition
    let priceToReturn = parseFloat(
      tags[card.conditionid === 5 ? 4 : card.conditionid - 1].match(
        /value="([\d\.]*)"/
      )[1]
    );

    // If the card is rare or mythic and the price is less than 1, set 1
    if (
      priceToReturn < 1 &&
      (card.rarity === "rare" || card.rarity === "mythic")
    ) {
      priceToReturn = 1;
    }

    // Store the price in the database. Parameterised: `path` is scraped out of
    // CardKingdom's HTML, so it is third-party text and must never be
    // concatenated into a statement.
    const updateResult = await client.query(
      "UPDATE card SET price = $1, ckuri = $2 WHERE id = $3",
      [priceToReturn, path, card.id]
    );
    if (updateResult.err) {
      throw updateResult.err;
    }

    return {
      price: priceToReturn,
      ckurl,
      ckuri,
    };
  } catch (e) {
    console.log(e);
    return {
      price: null,
      ckurl,
      ckuri,
    };
  }
}

// --------------------------------
// --------------------------------
// Attach each printing's would-be shop price, so the picker can show what a
// copy will cost when added — the same full selling rules (pins, NM reference,
// the $1 floor) a real stock row carries. `price` is null for a printing the
// shop has no reference for yet.
async function withQuotes(prisma, printings) {
  const quotes = await quotePrintings(prisma, printings);
  return printings.map((printing) => ({
    ...printing,
    price: quotes.get(printing.scryfallid) ?? null,
  }));
}

// Returns the versions of a specific card name.
//
// With `limit` in the query the answer is one page — `{ cards, total, offset }`
// — because a basic land has more printings than anybody should be sent at
// once; the picker walks pages instead. Without `limit` the old contract holds
// (everything, refused past 800) so existing callers keep working.
//
// `exact=1` matches the name exactly rather than by substring: a picker fed by
// the autocomplete has the exact name, and "Fog" by substring drags in Aven
// Fogbringer and friends. `set=` narrows to printings whose set name or code
// contains the text, for filtering as the user types.
// No .escape() on the name: it HTML-escaped the value before the lookup, so
// "Fire // Ice" became "Fire &#x2F;&#x2F; Ice" and split cards (and anything
// with an apostrophe) could never match. Prisma parameterizes the query;
// there is nothing to escape against.
router.get(
  "/versions/:cardName",
  asyncHandler(async (req, res) => {
    // Loads the data into a variable
    let cardName = req.params.cardName;

    // Verifies that the data was sent
    if (!cardName) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // Gets prisma from middleware
    const prisma = req.prisma;

    const where = {
      name:
        req.query.exact === "1"
          ? { equals: cardName, mode: "insensitive" }
          : { contains: cardName, mode: "insensitive" },
      ...PAPER_ONLY,
    };
    const setFilter = String(req.query.set ?? "").trim();
    if (setFilter) {
      where.OR = [
        { cardsetname: { contains: setFilter, mode: "insensitive" } },
        { cardsetcode: { contains: setFilter, mode: "insensitive" } },
      ];
    }
    const orderBy = [{ name: "asc" }, { cardsetcode: "asc" }];

    const limit = parseInt(req.query.limit, 10);
    if (Number.isFinite(limit) && limit > 0) {
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const [cards, total] = await Promise.all([
        prisma.cardgeneral.findMany({
          where,
          orderBy,
          skip: offset,
          take: Math.min(limit, 200),
        }),
        prisma.cardgeneral.count({ where }),
      ]);
      return res.status(200).json({ cards: await withQuotes(prisma, cards), total, offset });
    }

    // Finds the card in the database
    const cards = await prisma.cardgeneral.findMany({ where, orderBy });

    if (!cards) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    if (cards.length >= 800) {
      return res.status(400).json({ message: messages.TOO_MANY_CARDS });
    }

    return res.status(200).json({ cards: await withQuotes(prisma, cards) });
  })
);

// Card names matching what has been typed, for an autocomplete field.
//
// Distinct NAMES, not printings: a wishlist entry is a name, and the twelve
// printings of Lightning Bolt are one suggestion, not twelve.
//
// Suggestions come from the CATALOGUE, not from stock. A wishlist exists
// precisely for cards the shop does not have — suggesting only what is on the
// shelf would make it impossible to ask for the thing you actually want.
// Paper-only still applies: no point wishing for a card that cannot be printed.
//
// `stock=1` flips that around for the till: Vender can only sell what the
// store holds, so there it suggests only names with at least one approved copy
// filed in a for-sale container and not sitting in a pick-up bag — the same
// copies the off-sale subtraction in services/availability.js would count as
// sellable. Not exact availability (a copy reserved online but not yet pulled
// still suggests its name), but a name whose every copy is bagged or in a
// retired/released/returning container stays out of the list.
router.get(
  "/names",
  [check("q").trim().isLength({ min: 2 })],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Too short to be worth answering — an empty list, not an error, so the
      // field simply shows nothing until there is enough to go on.
      return res.status(200).json([]);
    }
    const q = String(req.query.q).trim();

    const IN_STOCK =
      req.query.stock === "1"
        ? {
            card: {
              some: {
                approved: true,
                collection: { active: true },
                cardplacement: {
                  some: {
                    orderlineid: null,
                    storage: { state: "for_sale" },
                  },
                },
              },
            },
          }
        : {};

    const LIMIT = 15;

    // A name that STARTS with what was typed is almost always the one meant, so
    // those are fetched as their own query rather than being sorted out of a
    // single one afterwards. Sorting after the fact does not work: `take` runs
    // in SQL, so "lightn" came back with the first fifteen alphabetical matches
    // — Arc Lightning, Ball Lightning, Barbed Lightning — and Lightning Bolt
    // was never among them to be promoted.
    const select = { name: true };
    const [starts, contains] = await Promise.all([
      req.prisma.cardgeneral.findMany({
        where: {
          name: { startsWith: q, mode: "insensitive" },
          ...PAPER_ONLY,
          ...IN_STOCK,
        },
        select,
        distinct: ["name"],
        orderBy: { name: "asc" },
        take: LIMIT,
      }),
      req.prisma.cardgeneral.findMany({
        where: {
          name: { contains: q, mode: "insensitive" },
          ...PAPER_ONLY,
          ...IN_STOCK,
        },
        select,
        distinct: ["name"],
        orderBy: { name: "asc" },
        take: LIMIT,
      }),
    ]);

    const seen = new Set();
    const names = [];
    for (const row of [...starts, ...contains]) {
      const key = row.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(row.name);
      if (names.length >= LIMIT) break;
    }

    return res.status(200).json(names);
  })
);

// Returns all the cards in a specific set
router.get("/set/:setId", [check("setId").escape()], asyncHandler(async (req, res) => {
  // Loads the data into a variable
  let setId = req.params.setId;

  // Verifies that the data was sent
  if (!setId) {
    return res.status(404).json({ message: messages.SET_NOT_FOUND });
  }

  // Gets prisma from middleware
  const prisma = req.prisma;

  const cards = await prisma.cardgeneral.findMany({
    where: { cardsetcode: setId, ...PAPER_ONLY },
  });

  if (!cards) {
    return res.status(404).json({ message: messages.CARD_NOT_FOUND });
  }

  if (cards.length >= 800) {
    return res.status(400).json({ message: messages.TOO_MANY_CARDS });
  }

  // Sort cards by number
  // Have to do it outside the prisma query because the number is a string
  cards.sort((a, b) => {
    try {
      if (parseInt(a.collectornumber) > parseInt(b.collectornumber)) {
        return 1;
      } else {
        return -1;
      }
    } catch {
      return 1;
    }
  });

  return res.status(200).json({ cards });
}));

// --------------------------------
// --------------------------------
// Returns the possible conditions and languages
router.get("/modifiers", asyncHandler(async (req, res) => {
  // Gets prisma from middleware
  const prisma = req.prisma;

  const conditions = await prisma.cardcondition.findMany();
  const languages = await prisma.cardlanguage.findMany();

  // Finishes have no lookup table; they are Scryfall's fixed vocabulary.
  return res.status(200).json({ conditions, languages, variants: FINISHES });
}));

// Returns the sets
router.get("/sets", asyncHandler(async (req, res) => {
  // Gets prisma from middleware
  const prisma = req.prisma;

  const sets = await prisma.cardset.findMany({
    where: PAPER_SETS_ONLY,
    orderBy: [{ releasedate: "desc" }, { cardsetname: "asc" }],
  });

  return res.status(200).json(sets);
}));

// Deletes a card with a certain ID
router.delete("/:cardId", [authentication, check("cardId").isNumeric()], asyncHandler(async (req, res) => {
  // Gets the playerId from the authentication middleware
  const playerId = requirePlayerId(req);

  const cardId = parseInt(req.params.cardId, 10);

  // Gets prisma from middleware
  const prisma = req.prisma;

  // Verifies that the card exists and that it's in the user's collection.
  // Scoping on playerid here is what stops one player deleting another's card.
  const card = await prisma.card.findFirst({
    where: { id: cardId, collection: { playerid: playerId } },
    select: { scryfallid: true },
  });
  if (!card) {
    return res.status(404).json({ message: messages.CARD_NOT_FOUND });
  }

  // If there are cards that match, delete them. Positions reference the card,
  // so they have to go first.
  await prisma.$transaction([
    prisma.cardplacement.deleteMany({ where: { cardid: cardId } }),
    prisma.card.delete({ where: { id: cardId } }),
  ]);

  return res.status(200).json(card);
}));

// NOTE: POST /:collectionId used to live here — it created a card row (or
// grew its quantity) WITHOUT a placement, and filing the copy into a
// container was a separate call the client had to remember to make. That
// two-step dance was the one mechanism that could leave copies with no
// container when the second call never came (network error, closed tab), so
// it was removed (2026-09-22) in favour of POST /mystorage/:storageId/add and
// POST /storage/:storageId/add, which create the card and place the copy in
// one transaction via addPrintingCopy.

// NOTE: two routes used to live here — POST /price/:cardid and
// POST /multipleprice — that scraped CardKingdom on demand. They were removed
// in the 2026 security pass. They were dead and dangerous: they called
// `client.query(...)`, but `client` is the connect FUNCTION from config/db.js,
// not a connected client, so every call threw. /price 500'd; /multipleprice
// threw inside a `.forEach(async …)` whose promise result was discarded, so
// the response was NEVER sent and the request hung — an unauthenticated-cost
// socket leak reachable by any logged-in user, with `req.body.cards` unbounded
// and un-role-gated. No UI called either. Pricing now runs through the
// owner-gated /admin pricing routes and the nightly sync. If on-demand
// scraping is ever wanted back, gate it to staff/owner, validate and bound the
// input, and use a real pg client.
export default router;
