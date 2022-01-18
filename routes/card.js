// Route file for card operations
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

// Returns all the versions of a specific card name
router.get("/versions/:cardName", [check("cardName").escape()], (req, res) => {
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
});

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
router.delete("/:cardId", [check("cardId").isNumeric()], (req, res) => {
  // Gets the userId from the authentication middleware
  var userId = req.userId;

  var cardId = req.params.cardId;

  // Verifies that the card exists and that it's in the user's collection
  let sql =
    "SELECT c.scryfallId FROM card c LEFT JOIN collection o ON c.collectionId = o.id LEFT JOIN user u ON o.userId = u.id WHERE c.id = " +
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
); // Add card
router.post(
  "/",
  [
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
