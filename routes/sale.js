// Route file for sales operations
var express = require("express");
var router = express.Router();
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
      'SELECT s.price, s.percent, s.quantity, s.date, s.conditionId, s.languageId, s.foil, cg.*, o.name AS "condition", l.name AS "language" FROM sale s LEFT JOIN cardGeneral cg ON s.scryfallId = cg.scryfallId LEFT JOIN cardCondition o ON s.conditionId = o.id LEFT JOIN cardLanguage l ON s.languageId = l.id WHERE collectionId = ' +
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

// Post a sale
router.post("/", (req, res) => {
  // Validates that the parameters are correct
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // If one of them isn't, returns an error
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }
  // Gets the userId from the authentication middleware
  var userId = req.userId;
  // Verify that the user is a superuser
  let sql = "SELECT superuser FROM user WHERE id = " + userId;
  let query = db.query(sql, (err, users) => {
    if (err) {
      throw err;
    }
    if (users.length == 0 || !users[0].superuser) {
      return res.status(403).json({ message: messages.UNAUTHORIZED });
    }

    // Sold card ids for getting them from database
    var soldCardIds = "(";

    // Gets cardId, price, quantity
    var soldCards = req.body.soldCards;

    var allDataCorrect = true;
    soldCards.forEach((card, index) => {
      // Verify that the data is correct
      if (isNaN(card.id) || isNaN(card.saleQuantity) || isNaN(card.price)) {
        allDataCorrect = false;
      }

      // Store the id for the query
      if (index != soldCards.length - 1) {
        soldCardIds = soldCardIds + card.id + ",";
      } else {
        soldCardIds = soldCardIds + card.id + ")";
      }
    });

    if (!allDataCorrect) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    sql =
      "SELECT c.id, c.quantity, c.conditionId, c.languageId, c.foil, c.collectionId, c.scryfallId, g.name AS 'cardName', o.percent FROM card c LEFT JOIN cardGeneral g ON c.scryfallId = g.scryfallId LEFT JOIN collection o ON c.collectionId = o.id WHERE c.id in " +
      soldCardIds;

    query = db.query(sql, (err, cardsInDb) => {
      if (err) {
        throw err;
      }

      // At this point:
      // - user is superuser
      // - soldCards has JSONs of the sold cards
      // - cardsInDb has those same cards from the db

      // Verifies that there are no repeat ids in the array
      var repeatCards = false;
      soldCards.forEach((cardCompared, indexCompared) => {
        soldCards.forEach((cardToCompare, indexToCompare) => {
          if (
            cardCompared.id == cardToCompare.id &&
            indexCompared != indexToCompare
          ) {
            repeatCards = true;
          }
        });
      });

      if (repeatCards) {
        return res.status(400).json({ message: messages.SALE_REPEAT_CARDS });
      }

      // Verifies that the cards exist
      var cardNotFound = null;
      soldCards.forEach((soldCard) => {
        var idFound = false;
        cardsInDb.forEach((cardInDb) => {
          if (soldCard.id == cardInDb.id) {
            idFound = true;
          }
        });
        if (!idFound) {
          cardNotFound = soldCard;
        }
      });
      if (cardNotFound) {
        return res
          .status(400)
          .json({ message: messages.SEARCH_NOT_FOUND, card: cardNotFound });
      }

      // Verifies that there is enough quantity of each card in the collectino
      var cardWithoutEnoughStock = null;
      soldCards.forEach((soldCard) => {
        cardsInDb.forEach((cardInDb) => {
          // If it already found one, stop verifying
          if (!cardWithoutEnoughStock) {
            if (
              soldCard.id == cardInDb.id &&
              soldCard.saleQuantity > cardInDb.quantity
            ) {
              cardWithoutEnoughStock = cardInDb;
            }
          }
        });
      });
      if (cardWithoutEnoughStock) {
        return res.status(400).json({
          message: messages.SALE_NOT_ENOUGH_STOCK,
          card: cardWithoutEnoughStock,
        });
      }

      // If al the data is correct, process the sale
      var today = new Date();
      today = Math.round(today / 1000);
      soldCards.forEach((soldCard) => {
        cardsInDb.forEach((cardInDb) => {
          if (soldCard.id == cardInDb.id) {
            sql =
              "INSERT INTO sale (collectionId, scryfallId, price, percent, quantity, date, conditionId, languageId, foil) VALUES (" +
              cardInDb.collectionId +
              ",'" +
              cardInDb.scryfallId +
              "'," +
              soldCard.price +
              "," +
              cardInDb.percent +
              "," +
              soldCard.saleQuantity +
              "," +
              today +
              "," +
              cardInDb.conditionId +
              "," +
              cardInDb.languageId +
              "," +
              cardInDb.foil +
              ")";
            query = db.query(sql, (err, cards) => {
              if (err) {
                throw err;
              }
            });
            // Modify the stock of the card
            if (soldCard.saleQuantity == cardInDb.quantity) {
              sql = "DELETE FROM card WHERE id = " + cardInDb.id;
            } else {
              sql =
                "UPDATE card SET quantity = " +
                (cardInDb.quantity - parseInt(soldCard.saleQuantity)) +
                " WHERE id = " +
                cardInDb.id;
            }
            query = db.query(sql, (err, cards) => {
              if (err) {
                throw err;
              }
            });
          }
        });
      });
      return res.status(201).json({ message: messages.SALE_PROCESSED });
    });
  });
});
module.exports = router;
