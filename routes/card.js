// Route file for card operations
import { Router } from "express";
import { request } from "https";
var router = Router();
import client from "../config/db.js";
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import { authentication } from "../middleware/authentication.js";

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

    // Store the price in the database
    const sql = `UPDATE card SET price = '${priceToReturn}', ckuri = '${path}' WHERE id = ${card.id}`;
    const updateResult = await client.query(sql);
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
// Returns all the versions of a specific card name
router.get(
  "/versions/:cardName",
  [check("cardName").escape()],
  asyncHandler(async (req, res) => {
    // Loads the data into a variable
    let cardName = req.params.cardName;

    // Verifies that the data was sent
    if (!cardName) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // Gets prisma from middleware
    const prisma = req.prisma;

    // Finds the card in the database
    const cards = await prisma.cardgeneral.findMany({
      where: { name: { contains: cardName, mode: "insensitive" } },
      orderBy: [{ name: "asc" }, { cardsetcode: "asc" }],
    });

    console.log(cards);

    if (!cards) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    if (cards.length >= 800) {
      return res.status(400).json({ message: messages.TOO_MANY_CARDS });
    }

    return res.status(200).json({ cards });
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
    where: { cardsetcode: setId },
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

  // Finishes have no lookup table — card.variant is a free-form nullable
  // string. Offer the canonical set plus anything the shop has actually used,
  // so a finish that only exists in stock still appears, and the common ones
  // appear even when nothing is stocked.
  const used = await prisma.card.findMany({
    distinct: ["variant"],
    select: { variant: true },
  });
  const variants = [
    ...new Set([
      "normal",
      "foil",
      "foil-etched",
      ...used.map((row) => row.variant).filter(Boolean),
    ]),
  ];

  return res.status(200).json({ conditions, languages, variants });
}));

// Returns the sets
router.get("/sets", asyncHandler(async (req, res) => {
  // Gets prisma from middleware
  const prisma = req.prisma;

  const sets = await prisma.cardset.findMany({
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
    check("condition").isNumeric().exists(),
    check("language").isNumeric().exists(),
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
    const conditionid = parseInt(req.body.condition);
    const languageid = parseInt(req.body.language);
    // `variant` is a string ("normal" / "foil"), not a number — parseInt on it
    // yielded NaN and Prisma rejected the write.
    const variant = req.body.variant ? String(req.body.variant) : "normal";

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

        return res.status(200).json({ message: messages.COLLECTION_UPDATED });
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

        return res.status(201).json({ message: messages.COLLECTION_UPDATED });
      }
    } catch (e) {
      console.log(e);
      return res.status(400).json({ error: e });
    }
  })
);

// --------------------------------
// --------------------------------
// Returns the price of a single card scrapped from CK
router.post("/price/:cardid", authentication, asyncHandler(async (req, res) => {
  const cardid = req.params.cardid;
  let sql = `SELECT c.id, c.price, c.priceupdate, c.conditionid, c.variant, c.ckuri, cg.* FROM card c LEFT JOIN cardgeneral cg ON c.scryfallid = cg.scryfallid WHERE c.id = '${cardid}'`;
  const cards = await client.query(sql);
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
      let sql = `SELECT c.id, c.price, c.priceupdate, c.conditionid, c.variant, c.ckuri, cg.* FROM card c LEFT JOIN cardgeneral cg ON c.scryfallid = cg.scryfallid WHERE c.id = '${card.id}'`;
      const responseCards = await client.query(sql);
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
