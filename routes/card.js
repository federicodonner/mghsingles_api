// Route file for card operations
import { Router } from "express";
import { request } from "https";
var router = Router();
import client from "../config/db.js";
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import { authentication } from "../middleware/authentication.js";
import { FINISHES, DEFAULT_FINISH, finishesFor } from "../services/finishes.js";
import { applyFixedPrice, applyReferencePrices } from "../services/pricing.js";
import { defaultIdentity } from "../services/identity.js";
import {
  PAPER_ONLY,
  PAPER_SETS_ONLY,
  isPaperPrinting,
} from "../services/paper.js";

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
      return res.status(200).json({ cards, total, offset });
    }

    // Finds the card in the database
    const cards = await prisma.cardgeneral.findMany({ where, orderBy });

    if (!cards) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    if (cards.length >= 800) {
      return res.status(400).json({ message: messages.TOO_MANY_CARDS });
    }

    return res.status(200).json({ cards });
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

// --------------------------------
// --------------------------------
// Add card
router.post(
  "/:collectionId",
  [
    authentication,
    check("scryfallId").escape().exists(),
    check("quantity").isNumeric().isFloat({ min: 1 }),
    check("condition").optional().isNumeric(),
    check("language").optional().isNumeric(),
    check("variant").optional().escape(),
    check("collectionId").isNumeric(),
  ],
  asyncHandler(async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    // Gets the playerId from the authentication middleware
    const playerId = requirePlayerId(req);
    // Gets the card collection from the request
    const collectionid = parseInt(req.params.collectionId);

    // Loads the data into variables to use
    const scryfallid = req.body.scryfallId;
    // Round the quantity in case the use sends a fraction
    const quantity = Math.floor(req.body.quantity);
    // The UI no longer asks for condition or language — a manual add is
    // assumed NM English. Explicit values (a future ManaBox import) still
    // land as sent; the columns keep being tracked either way.
    const assumed = await defaultIdentity(req.prisma);
    const conditionid = parseInt(req.body.condition) || assumed.conditionid;
    const languageid = parseInt(req.body.language) || assumed.languageid;
    // `variant` is a finish name, not a number — parseInt on it yielded NaN and
    // Prisma rejected the write.
    const variant = req.body.variant
      ? String(req.body.variant).trim()
      : DEFAULT_FINISH;

    // Gets prisma from middleware
    const prisma = req.prisma;

    try {
      // The collection must belong to the requesting player. Without this any
      // authenticated user could add cards to anyone else's collection.
      const collection = await prisma.collection.findFirst({
        where: { id: collectionid, playerid: playerId },
        select: { id: true },
      });
      if (!collection) {
        return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
      }

      const cardsInCardsGeneral = await prisma.cardgeneral.findUnique({
        where: { scryfallid },
      });

      // If there are no results, return error
      if (!cardsInCardsGeneral) {
        return res.status(404).json({ message: messages.CARD_NOT_FOUND });
      }

      // A digital-only printing cannot be graded, sleeved or handed over a
      // counter. The importer keeps these out of the catalogue entirely; this
      // is the boundary check, so a stale row from an older dump still cannot
      // become stock.
      if (!isPaperPrinting(cardsInCardsGeneral)) {
        return res.status(400).json({ message: messages.CARD_DIGITAL_ONLY });
      }

      // Half of all printings exist in only one finish, so a copy cannot claim
      // a finish its printing was never produced in.
      const available = finishesFor(cardsInCardsGeneral);
      if (!available.includes(variant)) {
        return res.status(400).json({
          message: messages.FINISH_NOT_AVAILABLE,
          finishes: available,
        });
      }

      // Tries to find the card in the collection, if it's there
      // add the quantity to the existing card
      const existingCard = await prisma.card.findFirst({
        where: { scryfallid, conditionid, languageid, variant, collectionid },
      });

      // If there are results, get the cardId
      if (existingCard) {
        await prisma.card.update({
          where: { id: existingCard.id },
          data: { quantity: existingCard.quantity + quantity },
        });

        return res.status(200).json({
          message: messages.COLLECTION_UPDATED,
          card: { id: existingCard.id, quantity: existingCard.quantity + quantity },
        });
      } else {
        // Adds the card to the database
        const newCard = await prisma.card.create({
          data: {
            scryfallid,
            conditionid,
            languageid,
            quantity,
            collectionid,
            variant,
          },
        });

        // Price the row the moment it exists, not at the next nightly run: a
        // pinned printing gets its fixed price, everything else gets the
        // stored CardKingdom reference — a card added today should not sit
        // priceless on the shelf until tomorrow's import.
        await applyFixedPrice(prisma, newCard);
        await applyReferencePrices(prisma, { onlyCardIds: [newCard.id] });

        // The id goes back so the caller can act on what it just created —
        // filing the copy straight into a container, for instance. Returning
        // only a message meant the customer added a card and then had to go and
        // find it again.
        return res.status(201).json({
          message: messages.COLLECTION_UPDATED,
          card: { id: newCard.id, quantity: newCard.quantity },
        });
      }
    } catch (e) {
      console.log(e);
      return res.status(400).json({ error: e });
    }
  })
);

// Everything the CardKingdom price scrape needs about one stock row.
// Parameterised — `cardid` arrives from a URL param and a request body, both of
// which used to be interpolated straight into the statement.
const CARD_FOR_PRICE_SQL =
  "SELECT c.id, c.price, c.priceupdate, c.conditionid, c.variant, c.ckuri, cg.* " +
  "FROM card c LEFT JOIN cardgeneral cg ON c.scryfallid = cg.scryfallid " +
  "WHERE c.id = $1";

// --------------------------------
// --------------------------------
// Returns the price of a single card scrapped from CK
router.post("/price/:cardid", authentication, asyncHandler(async (req, res) => {
  const cardid = parseInt(req.params.cardid, 10);
  if (!(cardid > 0)) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }
  const cards = await client.query(CARD_FOR_PRICE_SQL, [cardid]);
  if (cards.err) {
    throw cards.err;
  }

  if (!cards.rows.length) {
    return res.status(200).json({ price: null });
  }

  // FALTA VERIFICAR LA FECHA DE INGRESO DEL PRECIO
  // If there is already a price for the card return that
  if (cards.rows[0].price) {
    const ckurl = `https://${process.env.CARDKINGDOM_URL}${cards.rows[0].ckuri}`;
    return res.status(200).json({ price: cards.rows[0].price, ckurl });
  }

  const singlePriceResponse = await getSingleCardPrice(cards.rows[0]);

  if (!singlePriceResponse.price) {
    return res.status(404).json({
      message: "Precio no encontrado",
      ckurl: singlePriceResponse.ckurl,
    });
  }
  return res.status(200).json(singlePriceResponse);
}));

// --------------------------------
// --------------------------------
// Returns the price of a group of cards scrapped from CK
// Keep 2 seconds in between to avoid 429
router.post("/multipleprice", authentication, asyncHandler(async (req, res) => {
  const cards = req.body.cards;
  let prices = [];
  let scrappedCards = 0;

  new Promise((resolveList) => {
    // For each card, try to find the price in the database first
    cards.forEach(async (card, index) => {
      const responseCards = await client.query(CARD_FOR_PRICE_SQL, [
        parseInt(card.id, 10),
      ]);
      if (responseCards.err) {
        throw responseCards.err;
      }

      if (responseCards.rows.length) {
        // If the price is there, add it to the object
        if (responseCards.rows[0].price) {
          card.price = responseCards.rows[0].price;
          card.ckurl = `https://${process.env.CARDKINGDOM_URL}${responseCards.rows[0].ckuri}`;
        } else {
          // Scrapped cards adds a different delay for each card so that all
          // the requests are not done at the same time
          scrappedCards = scrappedCards + 1;
          // If it's not there, wait 1 second and fetch it from CK
          await new Promise((resolveIndividual) => {
            setTimeout(async () => {
              responseFromCK = await getSingleCardPrice(responseCards.rows[0]);
              card.price = responseFromCK.price;
              card.ckurl = responseFromCK.ckurl;
              resolveIndividual();
            }, scrappedCards * process.env.CARDKINGDOM_AWAIT_TIME);
          });
        }
      }
      if (index === cards.length - 1) {
        resolveList();
      }
    });
  }).then(() => {
    return res.status(200).json({ cards });
  });
}));
export default router;
