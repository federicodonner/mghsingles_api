// Route file for sales operations
var express = require("express");
var router = express.Router();
const multer = require("multer");
const upload = multer();
var db = require("../config/db");
const { check, validationResult } = require("express-validator");
var messages = require("../data/messages");

// Get the user's sales
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
      'SELECT s.price, s.percentage, s.quantity, s.date, s.conditionId, s.languageId, s.foil, cg.*, o.name AS "condition", l.name AS "language" FROM sale s LEFT JOIN cardGeneral cg ON s.scryfallId = cg.scryfallId LEFT JOIN cardCondition o ON s.conditionId = o.id LEFT JOIN cardLanguage l ON s.languageId = l.id WHERE collectionId = ' +
      collectionId;
    query = db.query(sql, (err, sales) => {
      if (err) {
        throw err;
      }
      collections[0].sales = sales;
      delete collections[0].id;
      delete collections[0].userId;
      res.status(200).json(collections[0]);
    });
  });
});

module.exports = router;
