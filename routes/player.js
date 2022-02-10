// Route file for getting and editing users
var express = require("express");
var router = express.Router();
var client = require("../config/db");
const {
  check,
  escape,
  isEmail,
  validationResult,
} = require("express-validator");
const bcrypt = require("bcrypt");
var messages = require("../data/messages");
var utils = require("../utils/utils");

// Create a new user
router.post(
  "/",
  [
    check("username").escape(),
    check("name").escape(),
    check("email").isEmail(),
  ],
  async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      // Verifies if the error is the email
      if (errors.errors[0].param === "email") {
        return res.status(400).json({ message: messages.EMAIL_ERROR });
      } else {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
    }
    // Loads the data into variables to use
    var username = req.body.username;
    var name = req.body.name;
    var email = req.body.email.toLowerCase();
    var password = req.body.password;

    // Validates that all the compulsory fields are present
    if (!username || !name || !email || !password) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Validates that the username has no spaces
    if (username.indexOf(" ") !== -1) {
      return res.status(400).json({ message: messages.USERNAME_INCORRECT });
    }

    // Verifies that the username is not already in use
    let sql = "SELECT * FROM player WHERE username = '" + username + "'";
    var results = await client.query(sql);
    if (results.err) {
      throw results.err;
    }
    // If there is at least one result, return error
    if (results.rows.length) {
      return res.status(400).json({ message: messages.USERNAME_REPEAT });
    }

    // Hash the password
    const hash = await bcrypt.hash(password, 8);
    // Adds the user to the database
    sql =
      "INSERT INTO player (username, name, email, passwordHash) VALUES ('" +
      username +
      "','" +
      name +
      "','" +
      email +
      "','" +
      hash +
      "') RETURNING id";
    results = await client.query(sql);
    if (results.err) {
      throw results.err;
    }

    // After the user is inserted, create a collection and add it to it
    // The new player id is returned from the insert statement
    var playerId = results.rows[0].id;

    sql =
      "INSERT INTO collection (playerid, active, percent) VALUES (" +
      playerId +
      ",1, 0.3)";
    var collection = await client.query(sql);
    if (collection.err) {
      throw collection.err;
    }

    // After the user is inserted, create a login record and return it
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
    results = await client.query(sql);
    if (results.err) {
      throw results.err;
    }
    // Add the generated token to the response
    res.status(201).send({ token: loginToken });
  }
);

// Update user details
router.put(
  "/",
  [check("name").escape().optional(), check("email").isEmail().optional()],
  async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    // Get the userId from the authentication middleware
    var playerId = req.playerId;

    // Get the new data from the body
    var name = req.body.name;
    var email = req.body.email;

    // If there is no data, return error
    if (!name && !email) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    let sql = "UPDATE player SET ";

    if (name) {
      sql = sql + "name='" + name + "'";
    }

    if (name && email) {
      sql = sql + ", ";
    }

    if (email) {
      sql = sql + "email='" + email + "'";
    }

    sql = sql + " WHERE id = " + playerId;
    sql = sql + " RETURNING username, name, email, id";
    let result = await client.query(sql);
    if (result.err) {
      throw result.err;
    }

    return res.status(200).json(result.rows[0]);
  }
);

// Update user password
router.put("/password", async (req, res) => {
  // Get the userId from the authentication middleware
  var playerId = req.playerId;

  // Get the new data from the body
  var password = req.body.password;
  var newPassword = req.body.newPassword;

  // If there is no data, return error
  if (!password || !newPassword) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }

  // Verify that the old password is correct
  let sql = "SELECT * FROM player WHERE id = " + playerId;
  let players = await client.query(sql);
  if (players.err) {
    throw players.err;
  }
  // Verifies that the password is correct
  hashedPassword = players.rows[0].passwordhash;
  let passwordResult = await bcrypt.compare(password, hashedPassword);
  if (!passwordResult) {
    return res.status(400).json({ message: messages.INCORRECT_PASSWORD });
  }

  // If the password is correct, create the hash and store it
  // Hash the password
  let hash = await bcrypt.hash(newPassword, 8);
  sql = "UPDATE player SET passwordHash='" + hash + "' WHERE id = " + playerId;
  let result = await client.query(sql);
  if (result.err) {
    throw result.err;
  }
  return res.status(200).json({ message: messages.USER_UPDATED });
});

// Return user's details based on the token
router.get("/me", async (req, res) => {
  // Gets the userId from the authentication middleware
  var playerId = req.playerId;
  let sql = "SELECT * FROM player WHERE id = " + playerId;
  let players = await client.query(sql);
  if (players.err) {
    throw players.err;
  }
  // If there are no results, return error
  if (!players.rows.length) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }
  // If there is a user, return it
  delete players.rows[0].passwordhash;
  delete players.rows[0].id;
  res.status(200).json(players.rows[0]);
});

module.exports = router;
