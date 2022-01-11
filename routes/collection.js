// Route file for operations to the user's collection
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
      "SELECT c.id, c.quantity, c.foil, c.targetPrice, cg.name, cg.cardSet, cg.cardSetName, cg.image, o.name AS 'condition', l.name AS 'language' FROM card c LEFT JOIN cardGeneral cg ON c.scryfallId = cg.scryfallId LEFT JOIN cardCondition o ON c.conditionId = o.id LEFT JOIN cardLanguage l ON c.languageId = l.id WHERE collectionId = " +
      collectionId;
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

router.post(
  "/",
  [
    upload.none(),
    check("scryfallId").escape(),
    check("quantity").isNumeric().isFloat({ min: 1 }),
    check("condition").isNumeric(),
    check("language").isNumeric(),
    check("foil").optional().isNumeric(),
  ],
  (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
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
      sql = "SELECT * FROM cardCondition WHERE id = " + condition;
      query = db.query(sql, (err, conditions) => {
        if (err) {
          throw err;
        }
        // If there are no results, return error
        if (!conditions.length) {
          return res.status(400).json({ message: messages.PARAMETERS_ERROR });
        }

        // Verifies that the selected language exists
        sql = "SELECT * FROM cardLanguage WHERE id = " + language;
        query = db.query(sql, (err, languages) => {
          if (err) {
            throw err;
          }
          // If there are no results, return error
          if (!languages.length) {
            return res.status(400).json({ message: messages.PARAMETERS_ERROR });
          }

          // Tries to find the card in the database
          sql =
            'SELECT * FROM cardGeneral WHERE scryfallId = "' + scryfallId + '"';
          query = db.query(sql, (err, cards) => {
            if (err) {
              throw err;
            }
            // If there are no results, return error
            if (!cards.length) {
              return res.status(404).json({ message: messages.CARD_NOT_FOUND });
            }

            // Tries to find the card in the collection, if it's there
            // add the quantity to the existing card
            let collectionId = collections[0].id;
            sql =
              'SELECT id, quantity FROM card WHERE scryfallId = "' +
              scryfallId +
              '" AND conditionId = ' +
              condition +
              " AND languageId = " +
              language +
              " AND foil = " +
              foil;

            query = db.query(sql, (err, cards) => {
              if (err) {
                throw err;
              }
              // If there are results, get the cardId
              if (cards.length) {
                sql =
                  "UPDATE card SET quantity = " +
                  (parseInt(cards[0].quantity) + quantity) +
                  " WHERE id = " +
                  cards[0].id;

                query = db.query(sql, (err, cards) => {
                  if (err) {
                    throw err;
                  }
                  return res
                    .status(200)
                    .json({ message: messages.COLLECTION_UPDATED });
                });
              } else {
                // Adds the card to the database
                sql =
                  'INSERT INTO card (scryfallId, conditionId, languageId, quantity, collectionId, foil) VALUES ("' +
                  scryfallId +
                  '",' +
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
                query = db.query(sql, (err, cards) => {
                  if (err) {
                    throw err;
                  }
                  return res
                    .status(201)
                    .json({ message: messages.COLLECTION_UPDATED });
                });
              }
            });
          });
        });
      });
    });
  }
);

module.exports = router;
