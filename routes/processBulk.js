var express = require("express");
var router = express.Router();
var db = require("../config/db");
var utils = require("../utils/utils");

// First, the route receives the request and pings Scryfall
// looking for the URL of the data bulk
router.get("/", (req, res) => {
  const scryfallUrl = process.env.SCRYFALL_BULK_URL;
  utils.accessURL(
    scryfallUrl,
    (bulkLibraries) => {
      // Once it has the bulk libraries, it finds the
      // unique_artwork URL
      var bulkDataURL = null;
      bulkLibraries.data.forEach((bulkPack) => {
        if (bulkPack.type === "default_cards") {
          bulkDataURL = bulkPack.download_uri;
        }
      });
      // Once it has the unique_artwork URL, it accesses it to find the data
      utils.accessURL(
        bulkDataURL,
        (data) => {
          // Once the data arrives, it processes it
          // Delets the old data
          let sql = "TRUNCATE TABLE cardGeneral";
          let query = db.query(sql, (err, results) => {
            if (err) {
              throw err;
            }
          });
          // numberOfCards allows the endpoint to report on how many cards it added
          let numberOfCards = 0;
          // It's going to process cards in batches of 1000
          let batchNumber = 5000;
          let maxIndexToInsert = batchNumber;
          let scryfallId;
          let name;
          let cardSetName;
          let cardSet;
          let image;
          while (maxIndexToInsert < data.length) {
            sql =
              "INSERT INTO cardGeneral (scryfallId, name, cardSet, cardSetName, image) VALUES ";
            for (
              let i = maxIndexToInsert - batchNumber;
              i < maxIndexToInsert;
              i++
            ) {
              // If the card is only digital, skip it
              if (!data[i].digital) {
                scryfallId = data[i].id;
                name = data[i].name.replace(/"/g, "");
                cardSetName = data[i].set_name;
                cardSet = data[i].set;
                // If the card has multiple faces, load the front one as the image
                if (data[i].card_faces) {
                  image = data[i].card_faces[0].image_uris?.normal;
                } else {
                  image = data[i].image_uris?.normal;
                }
                sql =
                  sql +
                  '("' +
                  scryfallId +
                  '","' +
                  name +
                  '","' +
                  cardSet +
                  '","' +
                  cardSetName +
                  '","' +
                  image +
                  '"),';
                numberOfCards++;
              }
            }
            sql =
              sql +
              '("00000-00000-' +
              maxIndexToInsert +
              '","Last card", "SET", "Last card set", "no image")';
            query = db.query(sql, (err, results) => {
              if (err) {
                throw err;
              }
            });
            maxIndexToInsert = maxIndexToInsert + batchNumber;
          }
          res
            .status(200)
            .send(
              "Update finished, " + numberOfCards + " cards added to database."
            );
        },
        res
      );
    },
    res
  );
});

module.exports = router;
