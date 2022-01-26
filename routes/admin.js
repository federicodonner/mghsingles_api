// Route file for operations to the user's collection
var express = require("express");
var router = express.Router();
var db = require("../config/db");
const { check, validationResult, isNumeric } = require("express-validator");
var messages = require("../data/messages");

router.post(
  "/payment",
  [check("collectionId").isNumeric(), check("ammount").isNumeric().isFloat()],
  (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    // Get the body content
    var collectionId = req.body.collectionId;
    var ammount = req.body.ammount;

    // Verifies that the collection exists
    let sql = "SELECT * FROM collection WHERE id = " + collectionId;
    let query = db.query(sql, (err, collections) => {
      if (err) {
        throw err;
      }
      // If there are no results, return error
      if (!collections.length) {
        return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
      }

      // Store the payment in the database
      var today = new Date();
      today = Math.round(today / 1000);
      sql =
        "INSERT INTO payment (date, ammount, collectionId) VALUES (" +
        today +
        "," +
        ammount +
        "," +
        collectionId +
        ")";
      query = db.query(sql, (err) => {
        if (err) {
          throw err;
        }

        // After the gasto is inserted, return it to the UI
        sql = "SELECT * FROM payment WHERE id = LAST_INSERT_ID()";
        query = db.query(sql, (err, results) => {
          if (err) {
            throw err;
          }
          res.status(201).json(results[0]);
        });
      });
    });
  }
);

// Post a sale
router.post("/sale", (req, res) => {
  // Gets the userId from the authentication middleware
  var userId = req.userId;

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

// Return user's details based on the token
// Copied form userRoute here to use the superuser middleware
router.get("/me", (req, res) => {
  // Gets the userId from the authentication middleware
  var userId = req.userId;
  let sql = "SELECT * FROM user WHERE id = " + userId;
  let query = db.query(sql, (err, users) => {
    if (err) {
      throw err;
    }
    // If there are no results, return error
    if (!users.length) {
      return res.status(401).json({ message: messages.UNAUTHORIZED });
    }
    // If there is a user, return it
    delete users[0].passwordHash;
    delete users[0].id;
    res.status(200).json(users[0]);
  });
});

// Return payments and sales from collections
router.get("/pendingpayments", (req, res) => {
  let sql =
    "SELECT u.name, one.collectionId, one.sales, one.commission, two.payments, (one.sales - one.commission - two.payments) AS 'outstanding' FROM (SELECT collectionId, SUM(price) AS 'sales', SUM(price*percent) AS 'commission' from sale GROUP BY collectionId) one LEFT JOIN (SELECT collectionId, SUM(ammount) AS 'payments' from payment GROUP BY collectionId) two ON one.collectionId = two.collectionId LEFT JOIN collection o ON one.collectionId = o.id LEFT JOIN user u ON o.userId = u.id";
  let query = db.query(sql, (err, collections) => {
    if (err) {
      throw err;
    }
    return res.status(200).json(collections);
  });
});

module.exports = router;
