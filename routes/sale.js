// Route file for sales operations
var express = require("express");
var router = express.Router();
var client = require("../config/db");
const { check, validationResult } = require("express-validator");
var messages = require("../data/messages");

// Get the user's sales
router.get("/", async (req, res) => {
  // Gets the playerId from the authentication middleware
  var playerId = req.playerId;
  // Gets the card collection
  let sql = "SELECT * FROM collection WHERE playerid = " + playerId;
  let collections = await client.query(sql);
  if (collections.err) {
    throw collections.err;
  }
  // If there are no results, return error
  if (!collections.rows.length) {
    return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
  }

  // If there is a collection, retrieve the cards.
  var collectionId = collections.rows[0].id;
  sql =
    "SELECT s.price, s.percent, s.quantity, s.date, s.conditionid, s.languageid, s.foil, cg.*, o.name AS condition, l.name AS language FROM sale s LEFT JOIN cardgeneral cg ON s.scryfallid = cg.scryfallid LEFT JOIN cardcondition o ON s.conditionid = o.id LEFT JOIN cardlanguage l ON s.languageid = l.id WHERE collectionid = " +
    collectionId +
    " ORDER BY s.date DESC, cg.name";
  let sales = await client.query(sql);
  if (sales.err) {
    throw sales.err;
  }
  collections.rows[0].sales = sales.rows;
  delete collections.rows[0].id;
  delete collections.rows[0].playerId;
  res.status(200).json(collections.rows[0]);
});

module.exports = router;
