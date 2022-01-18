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

module.exports = router;
