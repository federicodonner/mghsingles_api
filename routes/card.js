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

module.exports = router;
