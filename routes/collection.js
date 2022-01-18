// Route file for operations to the user's collection
var express = require("express");
var router = express.Router();
var db = require("../config/db");
const {
  check,
  escape,
  validationResult,
  isNumeric,
} = require("express-validator");
var messages = require("../data/messages");

// Get the user's collection
router.get("/", (req, res) => {
  // Gets the userId from the authentication middleware
  var userId = req.userId;
  // Gets the card collection
  let sql = "SELECT * FROM collection WHERE userId = " + userId;
  let query = db.query(sql, (err, collections) => {
    if (err) {
      throw err;
    }
    // If there are no results, return error
    if (!collections.length) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }

    // If there is a collection, retrieve the cards.
    var collectionId = collections[0].id;
    sql =
      "SELECT c.id, c.quantity, c.foil,  cg.name, cg.cardSet, cg.cardSetName, cg.image, o.name AS 'condition', l.name AS 'language' FROM card c LEFT JOIN cardGeneral cg ON c.scryfallId = cg.scryfallId LEFT JOIN cardCondition o ON c.conditionId = o.id LEFT JOIN cardLanguage l ON c.languageId = l.id WHERE collectionId = " +
      collectionId +
      " ORDER BY cg.name";
    query = db.query(sql, (err, cards) => {
      if (err) {
        throw err;
      }
      collections[0].cards = cards;
      delete collections[0].id;
      delete collections[0].userId;
      res.status(200).json(collections[0]);
    });
  });
});

// Get all collections
router.get("/all", (req, res) => {
  // Gets the userId from the authentication middleware
  var userId = req.userId;
  // Gets the card collection
  let sql =
    "SELECT o.id, u.name FROM collection o LEFT JOIN user u ON u.Id = o.userId ORDER BY u.name";
  let query = db.query(sql, (err, collections) => {
    if (err) {
      throw err;
    }
    // If there are no results, return error
    if (!collections.length) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }
    res.status(200).json(collections);
  });
});

module.exports = router;
