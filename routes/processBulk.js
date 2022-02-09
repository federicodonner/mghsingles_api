var express = require("express");
var router = express.Router();
var client = require("../config/db");
var utils = require("../utils/utils");
var messages = require("../data/messages");

// First, the route receives the request and pings Scryfall
// looking for the URL of the data bulk
router.get("/", async (req, res) => {
  const scryfallUrl = process.env.SCRYFALL_BULK_URL;
  try {
    const response = await utils.accessURL(scryfallUrl);
    // utils.accessURLDOS(scryfallUrl);
    const bulkLibraries = await response.json();
    // Once it has the bulk libraries, it finds the
    // unique_artwork URL
    var bulkDataURL = null;
    bulkLibraries.data.forEach((bulkPack) => {
      if (bulkPack.type === "default_cards") {
        bulkDataURL = bulkPack.download_uri;
      }
    });
    // Once it has the unique_artwork URL, it accesses it to find the data
    const cardsResponse = await utils.accessURL(bulkDataURL);
    const data = await cardsResponse.json();
    // Once the data arrives, it processes it
    // Delets the old data
    let sql = "TRUNCATE TABLE cardgeneral";
    let results = await client.query(sql);
    if (results.err) {
      throw results.err;
    }
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
    let donePassing = true;
    while (donePassing) {
      sql =
        "INSERT INTO cardgeneral (scryfallid, name, cardset, cardsetname, image) VALUES ";
      for (
        let i = maxIndexToInsert - batchNumber;
        i < Math.min(maxIndexToInsert, data.length);
        i++
      ) {
        // If the card is only digital, skip it
        if (!data[i].digital) {
          scryfallId = data[i].id;
          name = data[i].name.replace(/"/g, "");
          name = data[i].name.replace(/'/g, "");
          cardSetName = data[i].set_name.replace(/'/g, "");
          cardSet = data[i].set;
          // If the card has multiple faces, load the front one as the image
          if (data[i].image_uris?.normal) {
            image = data[i].image_uris?.normal;
          } else if (data[i].card_faces[0]?.image_uris?.normal) {
            image = data[i].card_faces[0].image_uris?.normal;
          }
          sql =
            sql +
            "('" +
            scryfallId +
            "','" +
            name +
            "','" +
            cardSet +
            "','" +
            cardSetName +
            "','" +
            image +
            "'),";
          numberOfCards++;
        }
      }
      sql =
        sql +
        "('00000-00000-" +
        maxIndexToInsert +
        "','Last card', 'SET', 'Last card set', 'no image')";
      results = await client.query(sql);
      if (results.err) {
        throw results.err;
      }
      // When it's the last pass, stop iterating
      if (maxIndexToInsert > data.length) {
        donePassing = false;
      }
      maxIndexToInsert = maxIndexToInsert + batchNumber;
    }
    res
      .status(200)
      .send(
        messages.UPDATE_FINISHED_1 + numberOfCards + messages.UPDATE_FINISHED_2
      );
  } catch (e) {
    if (e.type === "request-timeout") {
      return res.status(408).json({ message: messages.REQUEST_TIMEOUT });
    }
  }
});

module.exports = router;
