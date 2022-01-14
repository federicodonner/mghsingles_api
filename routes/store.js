// Route file for store
var express = require("express");
var router = express.Router();
var db = require("../config/db");
const { check, validationResult, escape } = require("express-validator");
var messages = require("../data/messages");

// Return all available cards in the store paginated
router.get("/:page", [check("page").isNumeric()], (req, res) => {
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
    "SELECT count(*) FROM card c LEFT JOIN collection o ON c.collectionId = o.id WHERE o.active = 1";
  let query = db.query(sql, (err, quantity) => {
    if (err) {
      throw err;
    }

    let objectToReturn = {
      numberOfCards: quantity[0]["count(*)"],
      numberOfPages: Math.ceil(quantity[0]["count(*)"] / pageSize),
    };

    // Get the cards from active collections
    sql =
      "SELECT c.id, c.scryfallId, c.quantity, c.foil, n.name AS 'condition', l.name AS 'language', g.name AS 'cardName', g.cardSetName, g.image FROM card c LEFT JOIN collection o ON c.collectionId = o.id LEFT JOIN cardLanguage l ON c.languageId = l.id LEFT JOIN cardCondition n ON c.conditionId = n.id LEFT JOIN cardGeneral g ON c.scryfallId = g.scryfallId WHERE o.active = 1 ORDER BY g.name";
    query = db.query(sql, (err, cards) => {
      if (err) {
        throw err;
      }

      // Paginate the results
      // If the total number of cards is less than one page, return them
      if (cards.length < pageSize) {
        objectToReturn.cards = cards;
      } else {
        // If there are more cards than one page, move the corresponding page to an arry to return
        let cardsToReturn = [];
        for (
          var i = (page - 1) * pageSize;
          i < Math.min(page * pageSize, cards.length);
          i++
        ) {
          cardsToReturn.push(cards[i]);
        }
        // return res.status(200).json(cardsToReturn);
        objectToReturn.cards = cardsToReturn;
      }
      return res.status(200).json(objectToReturn);
    });
  });
});

// Returns a specific card from the store
router.get("/search/:cardName", [check("cardName").escape()], (req, res) => {
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
    "SELECT count(*) FROM card c LEFT JOIN collection o ON c.collectionId = o.id WHERE o.active = 1";
  let query = db.query(sql, (err, quantity) => {
    if (err) {
      throw err;
    }

    let objectToReturn = {
      numberOfCards: quantity[0]["count(*)"],
      numberOfPages: Math.ceil(quantity[0]["count(*)"] / pageSize),
    };

    // Get the cards from active collections
    sql =
      "SELECT c.id, c.scryfallId, c.quantity, c.foil, n.name AS 'condition', l.name AS 'language', g.name AS 'cardName', g.cardSetName, g.cardSet, g.image, o.id AS 'collection', u.name AS 'user', o.percent FROM card c LEFT JOIN collection o ON c.collectionId = o.id LEFT JOIN cardLanguage l ON c.languageId = l.id LEFT JOIN cardCondition n ON c.conditionId = n.id LEFT JOIN cardGeneral g ON c.scryfallId = g.scryfallId LEFT JOIN user u ON o.userId = u.id WHERE o.active = 1 AND g.name like '%" +
      cardName +
      "%' ORDER BY g.name";
    query = db.query(sql, (err, cards) => {
      if (err) {
        throw err;
      }

      // If no cards match the search, return not found
      if (!cards.length) {
        return res.status(404).json({ message: messages.CARD_NOT_FOUND });
      }
      // Return the results
      objectToReturn.cards = cards;
      return res.status(200).json(objectToReturn);
    });
  });
});

module.exports = router;
