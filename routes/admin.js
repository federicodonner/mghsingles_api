// Route file for operations to the user's collection
var express = require("express");
var router = express.Router();
var client = require("../config/db");
const { check, validationResult, isNumeric } = require("express-validator");
var messages = require("../data/messages");

router.post(
  "/payment",
  [check("collectionId").isNumeric(), check("ammount").isNumeric().isFloat()],
  async (req, res) => {
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
    let collections = await client.query(sql);
    if (collections.err) {
      throw collections.err;
    }
    // If there are no results, return error
    if (!collections.rows.length) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }

    // Store the payment in the database
    var today = new Date();
    today = Math.round(today / 1000);
    sql =
      "INSERT INTO payment (date, ammount, collectionid) VALUES (" +
      today +
      "," +
      ammount +
      "," +
      collectionId +
      ") RETURNING date, ammount";
    let paymentInsert = await client.query(sql);
    if (paymentInsert.err) {
      throw paymentInsert.err;
    }

    res.status(201).json(paymentInsert.rows[0]);
  }
);

// Post a sale
router.post("/sale", async (req, res) => {
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
    "SELECT c.id, c.quantity, c.conditionid, c.languageid, c.foil, c.collectionid, c.scryfallid, g.name AS cardname, o.percent FROM card c LEFT JOIN cardgeneral g ON c.scryfallid = g.scryfallid LEFT JOIN collection o ON c.collectionid = o.id WHERE c.id in " +
    soldCardIds;

  let cardsInDb = await client.query(sql);
  if (cardsInDb.err) {
    throw cardsInDb.err;
  }

  // At this point:
  // - user is superuser (because of admin middleware)
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
    cardsInDb.rows.forEach((cardInDb) => {
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
    cardsInDb.rows.forEach((cardInDb) => {
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
  for (const soldCard of soldCards) {
    for (const cardInDb of cardsInDb.rows) {
      if (soldCard.id == cardInDb.id) {
        sql =
          "INSERT INTO sale (collectionid, scryfallid, price, percent, quantity, date, conditionid, languageid, foil) VALUES (" +
          cardInDb.collectionid +
          ",'" +
          cardInDb.scryfallid +
          "'," +
          soldCard.price +
          "," +
          cardInDb.percent +
          "," +
          soldCard.saleQuantity +
          "," +
          today +
          "," +
          cardInDb.conditionid +
          "," +
          cardInDb.languageid +
          "," +
          cardInDb.foil +
          ")";
        let addCards = await client.query(sql);
        if (addCards.err) {
          throw addCards.err;
        }
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
        let deleteCards = await client.query(sql);
        if (deleteCards.err) {
          throw deleteCards.err;
        }
      }
    }
  }
  return res.status(201).json({ message: messages.SALE_PROCESSED });
});

// Return user's details based on the token
// Copied form userRoute here to use the superuser middleware
router.get("/me", async (req, res) => {
  // Gets the playerId from the authentication middleware
  var playerId = req.playerId;
  let sql = "SELECT * FROM player WHERE id = " + playerId;
  let users = await client.query(sql);
  if (users.err) {
    throw users.err;
  }
  // If there are no results, return error
  if (!users.rows.length) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }
  // If there is a user, return it
  delete users.rows[0].passwordHash;
  delete users.rows[0].id;
  res.status(200).json(users.rows[0]);
});

// Return payments and sales from collections
router.get("/pendingpayments", async (req, res) => {
  let sql =
    "SELECT u.name, one.collectionid, one.sales, one.commission, two.payments, (one.sales - one.commission - two.payments) AS outstanding FROM (SELECT collectionid, SUM(price) AS sales, SUM(price*percent) AS commission from sale GROUP BY collectionid) one LEFT JOIN (SELECT collectionid, SUM(ammount) AS payments from payment GROUP BY collectionid) two ON one.collectionid = two.collectionid LEFT JOIN collection o ON one.collectionid = o.id LEFT JOIN player p ON o.playerid = p.id";
  let collections = await client.query(sql);
  if (collections.err) {
    throw collections.err;
  }
  return res.status(200).json(collections.rows);
});

module.exports = router;
