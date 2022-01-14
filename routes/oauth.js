// Route file for getting and editing gastos
var express = require("express");
var router = express.Router();
var db = require("../config/db");
const { check, escape, validationResult } = require("express-validator");
const bcrypt = require("bcrypt");
var messages = require("../data/messages");
var utils = require("../utils/utils");

// Validate the user and return the token
router.post("/", (req, res) => {
  // Validates that the parameters are correct
  // const errors = validationResult(req);
  // if (!errors.isEmpty()) {
  //   // If one of them isn't, returns an error
  //   return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  // }
  // Loads the data into variables to use
  var username = req.body.username;
  var password = req.body.password;

  // Validates that all the compulsory fields are present
  if (!username || !password) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }
  // Verifies that the user exists
  // HERE IT SHOULD CHECK THAT THE PASSWORD IS CORRECT
  let sql = "SELECT * FROM user WHERE username = '" + username + "'";
  let query = db.query(sql, (err, results) => {
    if (err) {
      throw err;
    }
    // Verifies that the user exists
    if (!results.length) {
      return res.status(404).json({ message: messages.USER_NOT_FOUND });
    }
    // Stores the superuser status of the user for the UI
    let superuser = results[0].superuser;
    // Verifies that the password is correct
    hashedPassword = results[0].passwordHash;
    bcrypt.compare(password, hashedPassword, function (err, passwordResult) {
      if (!passwordResult) {
        return res.status(401).json({ message: messages.INCORRECT_PASSWORD });
      }
      // Generate the login record with the token
      var userId = results[0].id;
      var currentTimestamp = Math.round(new Date() / 1000);
      var loginToken = utils.generateToken(25);
      sql =
        "INSERT INTO login (date, userId, token) VALUES (" +
        currentTimestamp +
        "," +
        userId +
        ",'" +
        loginToken +
        "')";
      query = db.query(sql, (err, results) => {
        if (err) {
          throw err;
        }
        return res.status(200).json({ token: loginToken, superuser });
      });
    });
  });
});

module.exports = router;
