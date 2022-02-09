// Route file for store
var express = require("express");
var router = express.Router();
var client = require("../config/db");
const { check, validationResult, escape } = require("express-validator");
var messages = require("../data/messages");

// Return all available cards in the store paginated
router.get("/:page", [check("page").isNumeric()], async (req, res) => {
  // Validates that the parameters are correct
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // If one of them isn't, returns an error
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }
  var page = req.params.page;
  let pageSize = 200;

  // Return how many cards there are for the UI to show
  let sql =
    "SELECT count(*) FROM card c LEFT JOIN collection o ON c.collectionid = o.id WHERE o.active = 1";
  let quantity = await client.query(sql);
  if (quantity.err) {
    throw quantity.err;
  }
  let objectToReturn = {
    numberOfCards: quantity.rows[0]["count"],
    numberOfPages: Math.ceil(quantity.rows[0]["count"] / pageSize),
  };

  // Get the cards from active collections
  sql =
    "SELECT c.id, c.scryfallid, c.quantity, c.foil, n.name AS condition, l.name AS language, g.name AS cardname, g.cardsetname, g.image FROM card c LEFT JOIN collection o ON c.collectionid = o.id LEFT JOIN cardlanguage l ON c.languageid = l.id LEFT JOIN cardcondition n ON c.conditionid = n.id LEFT JOIN cardgeneral g ON c.scryfallid = g.scryfallid WHERE o.active = 1 ORDER BY g.name";
  let cards = await client.query(sql);
  if (cards.err) {
    throw cards.err;
  }
  // Paginate the results
  // If the total number of cards is less than one page, return them
  if (cards.rows.length < pageSize) {
    objectToReturn.cards = cards.rows;
  } else {
    // If there are more cards than one page, move the corresponding page to an arry to return
    let cardsToReturn = [];
    for (
      var i = (page - 1) * pageSize;
      i < Math.min(page * pageSize, cards.rows.length);
      i++
    ) {
      cardsToReturn.push(cards.rows[i]);
    }
    // return res.status(200).json(cardsToReturn);
    objectToReturn.cards = cardsToReturn;
  }
  return res.status(200).json(objectToReturn);
});

// Returns a specific card from the store
router.get(
  "/search/:cardName",
  [check("cardName").escape()],
  async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    var cardName = req.params.cardName;

    let pageSize = 200;
    // Return how many cards there are for the UI to show
    let sql =
      "SELECT count(*) FROM card c LEFT JOIN collection o ON c.collectionid = o.id WHERE o.active = 1";
    let quantity = await client.query(sql);
    if (quantity.err) {
      throw quantity.err;
    }

    let objectToReturn = {
      numberOfCards: quantity.rows[0]["count"],
      numberOfPages: Math.ceil(quantity.rows[0]["count"] / pageSize),
    };

    // Get the cards from active collections
    sql =
      "SELECT c.id, c.scryfallid, c.quantity, c.foil, n.name AS condition, l.name AS language, g.name AS cardname, g.cardsetname, g.cardSet, g.image, o.id AS collection, p.name AS player, o.percent FROM card c LEFT JOIN collection o ON c.collectionid = o.id LEFT JOIN cardlanguage l ON c.languageid = l.id LEFT JOIN cardcondition n ON c.conditionid = n.id LEFT JOIN cardgeneral g ON c.scryfallid = g.scryfallid LEFT JOIN player p ON o.playerid = p.id WHERE o.active = 1 AND LOWER(g.name) like LOWER('%" +
      cardName +
      "%') ORDER BY g.name";
    let cards = await client.query(sql);
    if (cards.err) {
      throw cards.err;
    }
    // If no cards match the search, return not found
    if (!cards.rows.length) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }
    // Return the results
    objectToReturn.cards = cards.rows;
    return res.status(200).json(objectToReturn);
  }
);

module.exports = router;
