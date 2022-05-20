var express = require("express");
var router = express.Router();
var client = require("../config/db");
var utils = require("../utils/utils");
var messages = require("../data/messages");

// Add cards to cardgeneral
router.post("/", async (req, res) => {
  // Determines if posting sets or cards
  if(req.body.sets){

  // Get sets
  var setsToAdd = req.body.setsToAdd;
  // Check if the user wants to clear the database
  // should be set on the first call of the database update

  if (req.body.deleteDatabase) {
    sql = "TRUNCATE TABLE cardset";
    let resultsDropTable = await client.query(sql);
  }

  sql =
    "INSERT INTO cardset (cardsetname, releasedate, iconsvguri, cardset) VALUES ";
  setsToAdd.forEach((setToAdd, index) => {
    sql =
      sql +
      "('" +
      setToAdd.cardsetname +
      "','" +
      setToAdd.releasedate +
      "','" +
      setToAdd.iconsvguri +
      "','" +
      setToAdd.cardset +
      "')";
    if (index != setsToAdd.length - 1) {
      sql = sql + ",";
    }
  });

  let results = await client.query(sql);
  if (results.err) {
    console.log('error', sql);
    // throw results.err;
  }

    return res.status(200).json({message:'ok'})
  }

  // Get cards
  var cardsToAdd = req.body.cardsToAdd;
  // Check if the user wants to clear the database
  // should be set on the first call of the database update

  if (req.body.deleteDatabase) {
    sql = "TRUNCATE TABLE cardgeneral";
    let resultsDropTable = await client.query(sql);
  }

  sql =
    "INSERT INTO cardgeneral (scryfallid, name, cardset, cardsetname, image) VALUES ";
  cardsToAdd.forEach((cardToAdd, index) => {
    sql =
      sql +
      "('" +
      cardToAdd.scryfallid +
      "','" +
      cardToAdd.name +
      "','" +
      cardToAdd.cardset +
      "','" +
      cardToAdd.cardsetname +
      "','" +
      cardToAdd.image +
      "')";
    if (index != cardsToAdd.length - 1) {
      sql = sql + ",";
    }
  });

  let results = await client.query(sql);
  if (results.err) {
    console.log('eac');
    // throw results.err;
  }

 return res.status(200).json({ message: "ok" });

});

module.exports = router;
