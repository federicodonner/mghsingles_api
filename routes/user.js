// Route file for getting and editing users
var express = require("express");
var router = express.Router();
const multer = require("multer");
const upload = multer();
var db = require("../config/db");
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
    upload.none(),
    check("username").escape(),
    check("name").escape(),
    check("email").isEmail(),
  ],
  (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
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
    let sql = "SELECT * FROM user WHERE username = '" + username + "'";
    let query = db.query(sql, (err, results) => {
      if (err) {
        throw err;
      }
      // If there is at least one result, return error
      if (results.length) {
        return res.status(400).json({ message: messages.USERNAME_REPEAT });
      }

      // Hash the password
      bcrypt.hash(password, 8, function (err, hash) {
        // Adds the user to the database
        sql =
          "INSERT INTO user (username, name, email, passwordHash) VALUES ('" +
          username +
          "','" +
          name +
          "','" +
          email +
          "','" +
          hash +
          "')";
        query = db.query(sql, (err, results) => {
          if (err) {
            throw err;
          }

          // After the usuario is inserted, create a login record and return it
          sql = "SELECT * FROM user WHERE id = LAST_INSERT_ID()";
          query = db.query(sql, (err, userResults) => {
            if (err) {
              throw err;
            }
            var userId = userResults[0].id;
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
              // Add the generated token to the response
              userResults[0].token = loginToken;
              delete userResults[0].id;
              delete userResults[0].passwordHash;
              res.status(201).send(userResults[0]);
            });
          });
        });
      });
    });
  }
);

module.exports = router;
