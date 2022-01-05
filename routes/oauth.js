// Route file for getting and editing gastos
var express = require("express");
var router = express.Router();
const multer = require("multer");
const upload = multer();
var db = require("../config/db");
const { check, escape, validationResult } = require("express-validator");
var messages = require("../data/messages");
var utils = require("../utils/utils");

// Validate the user and return the token
// MISSING PASSWORD VALIDATION, V1 WON'T HAVE PASSOWRD
router.post("/", [upload.none(), check("username").escape()], (req, res) => {
  // Validates that the parameters are correct
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // If one of them isn't, returns an error
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }
  // Loads the data into variables to use
  var username = req.body.username;

  // Validates that all the compulsory fields are present
  if (!username) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }
  // Verifies that the user exists
  // HERE IT SHOULD CHECK THAT THE PASSWORD IS CORRECT
  let sql = "SELECT * FROM user WHERE username = '" + username + "'";
  let query = db.query(sql, (err, results) => {
    if (err) {
      throw err;
    }
    // Verify that there is at least one casa with that hash
    if (!results.length) {
      return res.status(404).json({ message: messages.USUARIO_NOT_FOUND });
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
      return res.status(200).json({ token: loginToken });
    });
  });
});

module.exports = router;
