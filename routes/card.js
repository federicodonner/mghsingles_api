// Route file for card operations
var express = require("express");
var https = require("https");
var router = express.Router();
var client = require("../config/db");
const {
  check,
  escape,
  validationResult,
  isNumeric,
} = require("express-validator");
var messages = require("../data/messages");

async function getExternalUrl(path) {
  const options = {
    host: process.env.CARDKINGDOM_URL,
    port: 443,
    path: path,
  };
  let content = "";

  return new Promise(function (resolve, reject) {
    var req = https.request(options, function (res) {
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
  async (req, res) => {
    // Loads the data into a variable
    let cardName = req.params.cardName;

    // Verifies that the data was sent
    if (!cardName) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // Finds the card in the database
    let sql =
      "SELECT * FROM cardgeneral WHERE LOWER(name) like LOWER('%" +
      cardName +
      "%') ORDER BY name, cardset";
    let cards = await client.query(sql);
    if (cards.err) {
      throw cards.err;
    }
    if (!cards.rows.length) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    if (cards.rows.length >= 800) {
      return res.status(400).json({ message: messages.TOO_MANY_CARDS });
    }

    return res.status(200).json({ cards: cards.rows });
  }
);

// Returns all the cards in a specific set
router.get("/set/:setId", [check("setId").escape()], async (req, res) => {
  // Loads the data into a variable
  let setId = req.params.setId;

  // Verifies that the data was sent
  if (!setId) {
    return res.status(404).json({ message: messages.SET_NOT_FOUND });
  }

  // ESTOY ACÁ

  // Finds the card in the database
  let sql = "SELECT * FROM";
  "SELECT * FROM cardset WHERE id = " + setId + ";";
  let sets = await client.query(sql);
  if (cards.err) {
    throw cards.err;
  }
  if (!cards.rows.length) {
    return res.status(404).json({ message: messages.CARD_NOT_FOUND });
  }

  if (cards.rows.length >= 800) {
    return res.status(400).json({ message: messages.TOO_MANY_CARDS });
  }

  return res.status(200).json(cards.rows);
});

// --------------------------------
// --------------------------------
// Returns the possible conditions and languages
router.get("/modifiers", async (req, res) => {
  let sql = "SELECT * FROM cardcondition";
  let conditions = await client.query(sql);
  if (conditions.err) {
    throw conditions.err;
  }
  sql = "SELECT * FROM cardlanguage";
  let languages = await client.query(sql);
  if (languages.err) {
    throw languages.err;
  }
  res
    .status(200)
    .json({ conditions: conditions.rows, languages: languages.rows });
});

// Returns the sets
router.get("/sets", async (req, res) => {
  let sql = "SELECT * FROM cardSet ORDER BY releasedate DESC";
  let sets = await client.query(sql);
  if (sets.err) {
    throw sets.err;
  }
  res.status(200).json({ sets: sets.rows });
});

// Deletes a card with a certain ID
router.delete("/:cardId", [check("cardId").isNumeric()], async (req, res) => {
  // Gets the playerId from the authentication middleware
  var playerId = req.playerId;

  var cardId = req.params.cardId;

  // Verifies that the card exists and that it's in the user's collection
  let sql =
    "SELECT c.scryfallid FROM card c LEFT JOIN collection o ON c.collectionid = o.id LEFT JOIN player p ON o.playerid = p.id WHERE c.id = " +
    cardId +
    " AND p.id = " +
    playerId;
  let cards = await client.query(sql);
  if (cards.err) {
    throw cards.err;
  }
  if (!cards.rows.length) {
    return res.status(404).json({ message: messages.CARD_NOT_FOUND });
  }

  // If there are cards that match, delete them
  sql = "DELETE FROM card WHERE id = " + cardId;
  let deletes = await client.query(sql);
  if (deletes.err) {
    throw deletes.err;
  }

  return res.status(200).json(cards.rows[0]);
});

// --------------------------------
// --------------------------------
// Add card
router.post(
  "/",
  [
    check("scryfallId").escape().exists(),
    check("quantity").isNumeric().isFloat({ min: 1 }),
    check("condition").isNumeric().exists(),
    check("language").isNumeric().exists(),
    check("variant").optional().escape(),
  ],
  async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    // Gets the playerId from the authentication middleware
    var playerId = req.playerId;
    // Gets the card collection
    let sql = `SELECT * FROM collection WHERE playerid = ${playerId}`;
    let collections = await client.query(sql);
    if (collections.err) {
      throw collections.err;
    }
    // If there are no results, return error
    if (!collections.rows.length) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }
    // Loads the data into variables to use
    var scryfallId = req.body.scryfallId;
    // Round the quantity in case the use sends a fraction
    var quantity = Math.floor(req.body.quantity);
    var condition = req.body.condition;
    var language = req.body.language;
    var variant = req.body.variant;

    // Verifies that the selected condition exists
    sql = `SELECT * FROM cardcondition WHERE id = ${condition}`;
    let conditions = await client.query(sql);
    if (conditions.err) {
      throw conditions.err;
    }
    // If there are no results, return error
    if (!conditions.rows.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Verifies that the selected language exists
    sql = `SELECT * FROM cardlanguage WHERE id = ${language}`;
    let languages = await client.query(sql);
    if (languages.err) {
      throw languages.err;
    }
    // If there are no results, return error
    if (!languages.rows.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Tries to find the card in the database
    sql = `SELECT * FROM cardgeneral WHERE scryfallid = '${scryfallId}'`;
    let cards = await client.query(sql);
    if (cards.err) {
      throw cards.err;
    }
    // If there are no results, return error
    if (!cards.rows.length) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // let card = cards.rows[0];
    // card.conditionid = condition;
    // card.variant = variant;
    // // The card exists, so it tries to find the price

    // const singlePriceResponse = await getSingleCardPrice(cards.rows[0]);

    // Tries to find the card in the collection, if it's there
    // add the quantity to the existing card
    let collectionId = collections.rows[0].id;
    sql = `SELECT id, quantity FROM card WHERE scryfallid = '${scryfallId}' AND conditionid = ${condition} AND languageid = ${language} AND variant = '${variant}'`;
    let existingCards = await client.query(sql);
    if (existingCards.err) {
      throw existingCards.err;
    }
    // If there are results, get the cardId
    if (existingCards.rows.length) {
      sql = `UPDATE card SET quantity = ${
        parseInt(existingCards.rows[0].quantity) + quantity
      } WHERE id = ${existingCards.rows[0].id}`;

      let addCards = await client.query(sql);
      if (addCards.err) {
        throw addCards.err;
      }
      return res.status(200).json({ message: messages.COLLECTION_UPDATED });
    } else {
      // Adds the card to the database
      sql = `INSERT INTO card (scryfallid, conditionid, languageid, quantity, collectionid, variant) VALUES ('${scryfallId}',${condition},${language},${quantity},${collectionId},'${variant}') RETURNING id, conditionid, variant`;
      let addCards = await client.query(sql);
      if (addCards.err) {
        throw addCards.err;
      }

      // After the card is inserted, find the price and update the database

      sql = `SELECT c.id, c.price, c.priceupdate, c.conditionid, c.variant, c.ckuri, cg.* FROM card c LEFT JOIN cardgeneral cg ON c.scryfallid = cg.scryfallid WHERE c.id = '${addCards.rows[0].id}'`;
      const cards = await client.query(sql);
      if (cards.err) {
        throw cards.err;
      }

      const singlePriceResponse = await getSingleCardPrice(cards.rows[0]);

      // After the card is inserted, get the price and update it
      return res.status(201).json({ message: messages.COLLECTION_UPDATED });
    }
  }
);

// --------------------------------
// --------------------------------
// Returns the price of a single card scrapped from CK
router.post("/price/:cardid", async (req, res) => {
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
});

// --------------------------------
// --------------------------------
// Returns the price of a group of cards scrapped from CK
// Keep 2 seconds in between to avoid 429
router.post("/multipleprice", async (req, res) => {
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
});
module.exports = router;
