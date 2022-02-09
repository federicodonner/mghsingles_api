// Route file for card operations
var express = require("express");
var router = express.Router();
var client = require("../config/db");
const {
  check,
  escape,
  validationResult,
  isNumeric,
} = require("express-validator");
var messages = require("../data/messages");

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

    return res.status(200).json(cards.rows);
  }
);

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

// Add card
router.post(
  "/",
  [
    check("scryfallId").escape(),
    check("quantity").isNumeric().isFloat({ min: 1 }),
    check("condition").isNumeric(),
    check("language").isNumeric(),
    check("foil").optional().isNumeric(),
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
    let sql = "SELECT * FROM collection WHERE playerid = " + playerId;
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
    var foil = req.body.foil;

    // Verifies that the data was sent
    if (
      !scryfallId ||
      !quantity ||
      !condition ||
      !language ||
      !foil ||
      (foil !== "1" && foil !== "0")
    ) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Verifies that the selected condition exists
    sql = "SELECT * FROM cardcondition WHERE id = " + condition;
    let conditions = await client.query(sql);
    if (conditions.err) {
      throw conditions.err;
    }
    // If there are no results, return error
    if (!conditions.rows.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Verifies that the selected language exists
    sql = "SELECT * FROM cardlanguage WHERE id = " + language;
    let languages = await client.query(sql);
    if (languages.err) {
      throw languages.err;
    }
    // If there are no results, return error
    if (!languages.rows.length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Tries to find the card in the database
    sql = "SELECT * FROM cardgeneral WHERE scryfallid = '" + scryfallId + "'";
    let cards = await client.query(sql);
    if (cards.err) {
      throw cards.err;
    }
    // If there are no results, return error
    if (!cards.rows.length) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // Tries to find the card in the collection, if it's there
    // add the quantity to the existing card
    let collectionId = collections.rows[0].id;
    sql =
      "SELECT id, quantity FROM card WHERE scryfallid = '" +
      scryfallId +
      "' AND conditionid = " +
      condition +
      " AND languageid = " +
      language +
      " AND foil = " +
      foil;
    console.log(sql);
    let existingCards = await client.query(sql);
    if (existingCards.err) {
      throw existingCards.err;
    }
    // If there are results, get the cardId
    if (existingCards.rows.length) {
      sql =
        "UPDATE card SET quantity = " +
        (parseInt(existingCards.rows[0].quantity) + quantity) +
        " WHERE id = " +
        existingCards.rows[0].id;

      let addCards = await client.query(sql);
      if (addCards.err) {
        throw addCards.err;
      }
      return res.status(200).json({ message: messages.COLLECTION_UPDATED });
    } else {
      // Adds the card to the database
      sql =
        "INSERT INTO card (scryfallid, conditionid, languageid, quantity, collectionid, foil) VALUES ('" +
        scryfallId +
        "'," +
        condition +
        "," +
        language +
        "," +
        quantity +
        "," +
        collectionId +
        "," +
        foil +
        ")";
      let addCards = await client.query(sql);
      if (addCards.err) {
        throw addCards.err;
      }
      return res.status(201).json({ message: messages.COLLECTION_UPDATED });
    }
  }
);

module.exports = router;
