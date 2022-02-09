// Route file for getting and editing gastos
var express = require("express");
var router = express.Router();
var client = require("../config/db");
const { check, escape, validationResult } = require("express-validator");
const bcrypt = require("bcrypt");
var messages = require("../data/messages");
var utils = require("../utils/utils");

// Validate the user and return the token
router.post("/", async (req, res) => {
  // Loads the data into variables to use
  var username = req.body.username;
  var password = req.body.password;

  // Validates that all the compulsory fields are present
  if (!username || !password) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }
  // Verifies that the user exists
  let sql = "SELECT * FROM player WHERE username = '" + username + "'";
  // let rows = client.query(sql);
  var players = await client.query(sql);
  if (players.err) {
    throw players.err;
  }

  // Verifies that the user exists
  if (!players.rows.length) {
    return res.status(404).json({ message: messages.USER_NOT_FOUND });
  }
  // Stores the superuser status of the user for the UI
  let superuser = players.rows[0].superuser;
  // Verifies that the password is correct
  hashedPassword = players.rows[0].passwordhash;
  const passwordResult = await bcrypt.compare(password, hashedPassword);
  if (!passwordResult) {
    return res.status(401).json({ message: messages.INCORRECT_PASSWORD });
  }
  // Generate the login record with the token
  var playerId = players.rows[0].id;
  var currentTimestamp = Math.round(new Date() / 1000);
  var loginToken = utils.generateToken(25);
  sql =
    "INSERT INTO login (date, playerid, token) VALUES (" +
    currentTimestamp +
    "," +
    playerId +
    ",'" +
    loginToken +
    "')";
  var loginQuery = await client.query(sql);
  if (loginQuery.err) {
    throw loginQuery.err;
  }
  return res.status(200).json({ token: loginToken, superuser });
});

module.exports = router;
