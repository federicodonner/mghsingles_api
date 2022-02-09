// Route file for operations to the user's collection
var express = require("express");
var router = express.Router();
var client = require("../config/db");
const {
  check,
  escape,
  validationResult,
  isNumeric,
} = require("express-validator");
var messages = require("../data/messages");

// Get the user's collection
router.get("/", async (req, res) => {
  // Gets the userId from the authentication middleware
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
    "SELECT c.id, c.quantity, c.foil,  cg.name, cg.cardset, cg.cardsetname, cg.image, o.name AS condition, l.name AS language FROM card c LEFT JOIN cardgeneral cg ON c.scryfallid = cg.scryfallid LEFT JOIN cardcondition o ON c.conditionid = o.id LEFT JOIN cardlanguage l ON c.languageid = l.id WHERE collectionid = " +
    collectionId +
    " ORDER BY cg.name";
  let cards = await client.query(sql);
  if (cards.err) {
    throw cards.err;
  }
  collections.rows[0].cards = cards.rows;
  delete collections.rows[0].id;
  delete collections.rows[0].playerid;
  res.status(200).json(collections.rows[0]);
});

// Get all collections
router.get("/all", async (req, res) => {
  // Gets the userId from the authentication middleware
  var userId = req.userId;
  // Gets the card collection
  let sql =
    "SELECT o.id, p.name FROM collection o LEFT JOIN player p ON p.id = o.playerid ORDER BY p.name";
  let collections = await client.query(sql);
  if (collections.err) {
    throw collections.err;
  }
  // If there are no results, return error
  if (!collections.rows.length) {
    return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
  }
  res.status(200).json(collections.rows);
});

module.exports = router;
