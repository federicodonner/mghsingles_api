// Route file for card operations
var express = require("express");
var router = express.Router();
const multer = require("multer");
const upload = multer();
var db = require("../config/db");
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
  [upload.none(), check("cardName").escape()],
  (req, res) => {
    // Loads the data into a variable
    let cardName = req.params.cardName;

    // Verifies that the data was sent
    if (!cardName) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // Finds the card in the database
    let sql =
      'SELECT * FROM cardGeneral WHERE name like "%' +
      cardName +
      '%" ORDER BY name, cardSet';
    let query = db.query(sql, (err, cards) => {
      if (err) {
        throw err;
      }
      if (!cards.length) {
        return res.status(404).json({ message: messages.CARD_NOT_FOUND });
      }

      if (cards.length >= 800) {
        return res.status(400).json({ message: messages.TOO_MANY_CARDS });
      }

      return res.status(200).json(cards);
    });
  }
);

// Returns the possible conditions and languages
router.get("/modifiers", (req, res) => {
  let sql = "SELECT * FROM cardCondition";
  let query = db.query(sql, (err, conditions) => {
    if (err) {
      throw err;
    }
    sql = "SELECT * FROM cardLanguage";
    let query = db.query(sql, (err, languages) => {
      if (err) {
        throw err;
      }
      res.status(200).json({ conditions, languages });
    });
  });
});

// Deletes a card with a certain ID
router.delete(
  "/:cardId",
  [upload.none(), check("cardId").isNumeric()],
  (req, res) => {
    // Gets the userId from the authentication middleware
    var userId = req.userId;

    var cardId = req.params.cardId;

    // Verifies that the card exists and that it's in the user's collection
    let sql =
      "SELECT c.scryfallId FROM card c  LEFT JOIN collection o ON c.collectionId = o.id LEFT JOIN user u ON o.userId = u.id WHERE c.id = " +
      cardId +
      " AND u.id = " +
      userId;
    let query = db.query(sql, (err, cards) => {
      if (err) {
        throw err;
      }
      if (!cards.length) {
        return res.status(404).json({ message: messages.CARD_NOT_FOUND });
      }

      // If there are cards that match, delete them
      sql = "DELETE FROM card WHERE id = " + cardId;
      let query = db.query(sql, (err, deletes) => {
        if (err) {
          throw err;
        }

        return res.status(200).json(cards[0]);
      });
    });
  }
);

module.exports = router;
