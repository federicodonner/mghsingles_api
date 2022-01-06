var express = require("express");
var router = express.Router();
var fetch = require("cross-fetch");
var db = require("../config/db");

// First, the route receives the request and pings Scryfall
// looking for the URL of the data bulk
router.get("/", (req, res) => {
  const scryfallUrl = process.env.SCRYFALL_BULK_URL;
  accessURL(
    scryfallUrl,
    (bulkLibraries) => {
      // Once it has the bulk libraries, it finds the
      // unique_artwork URL
      var bulkDataURL = null;
      bulkLibraries.data.forEach((bulkPack) => {
        if (bulkPack.type === "unique_artwork") {
          bulkDataURL = bulkPack.download_uri;
        }
      });
      // Once it has the unique_artwork URL, it accesses it to find the data
      accessURL(
        bulkDataURL,
        (data) => {
          // Once the data arrives, it processes it
          let sql = "TRUNCATE TABLE cardGeneral";
          let query = db.query(sql, (err, results) => {
            if (err) {
              throw err;
            }
          });
          let numberOfCards = 0;
          data.forEach((card) => {
            let scryfallId = card.id;
            let name = card.name.replace(/"/g, "");
            let cardSet = card.set_name;
            let image = card.image_uris?.normal;
            sql =
              'INSERT INTO cardGeneral (scryfallId, name, cardSet, image) VALUES ("' +
              scryfallId +
              '","' +
              name +
              '","' +
              cardSet +
              '","' +
              image +
              '")';
            query = db.query(sql, (err, results) => {
              if (err) {
                throw err;
              }
            });
            numberOfCards++;
          });
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

// Access external URL
// Receives res to be able to return errors if they happen
function accessURL(url, successCallback, res) {
  Promise.race([
    // Generate two promies, one with the fecth and the other with the timeout
    // the one that finishes first resolves
    fetch(url, { method: "GET" }),
    new Promise(function (resolve, reject) {
      setTimeout(() => reject(new Error("request timeout")), 30000);
    }),
  ])
    .then((response) => {
      // When race resolves, it verifies the status of the API response
      // If it's 200 or 201, it was successful
      // Get the URI for the resource to get the new fetch.
      if (response.status >= 200 && response.status < 300) {
        response.json().then((data) => {
          successCallback(data);
        });
      } else {
        response.json().then((data) => {
          data.status = response.status;
          res.send(data);
        });
      }
    })
    .catch((e) => {
      // var response = {
      //   status: 500,
      //   detail: texts.API_ERROR,
      // };
      res.send("error");
    });
}

module.exports = router;
