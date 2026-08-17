import fetch from "cross-fetch";
import { readFileSync } from "fs";

// Function used in the color sorting to return them in UWBRG order
function sortByWUBRG(a, b) {
  if (a === b) {
    return 0;
  }

  if (
    a === "W" ||
    (a === "U" && b !== "W") ||
    (a === "B" && b !== "W" && b !== "U") ||
    (a === "R" && b !== "W" && b !== "U" && b !== "B")
  ) {
    return -1;
  }

  return 1;
}

// First, the route receives the request and pings Scryfall
// looking for the URL of the data bulk
async function getScryfallCollectionURL() {
  const scryfallUrl = "http://api.scryfall.com";
  const bulkDataUri = "/bulk-data";
  const setsUri = "/sets";
  const ROUTE_TO_LOCAL_FILE = "./default-cards-20250825090922.json";

  // Verify if the --dev flag is entered and set URLs accordingly
  let apiUrl;
  if (process.argv.slice(2)[0] == "--dev") {
    apiUrl = "http://localhost:3001/bulk";
    console.log("⚠️  Modo developer seleccionado");
    console.log("⚠️  Guardando en base de datos local");
  } else {
    apiUrl = "http://mghsingles.herokuapp.com/bulk";
  }
  const batchNumber = 200;
  let maxIndexToInsert = batchNumber;
  let addedCards = 0;
  let addedSets = 0;

  console.log("✅ Iniciando importación");
  process.stdout.write("🔄 Descargando sets");
  try {
    // Import the sets information
    const setsResponse = await fetch(scryfallUrl + setsUri, {
      method: "GET",
      timeout: 30000,
    });

    let setsInformation = await setsResponse.json();
    setsInformation = setsInformation.data;

    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write("✅ Descargando sets\n");

    // Sets the variables for each card to add to the array to send
    let cardsetname;
    let releasedate;
    let iconsvguri;
    let cardset;
    let donePassing = false;

    while (!donePassing) {
      var setsToAdd = [];
      // Creates a batch of sets to upload
      for (
        var i = maxIndexToInsert - batchNumber;
        i < Math.min(maxIndexToInsert, setsInformation.length);
        i++
      ) {
        const setToAdd = setsInformation[i];
        // If the set name contains any form of Secret Lair
        // substitute it by exactly Secret Lair
        if (setToAdd.name.indexOf("Secret Lair") !== -1) {
          cardsetname = "Secret Lair";
        } else if (setToAdd.name === "Limited Edition Alpha") {
          cardsetname = "Alpha";
        } else if (setToAdd.name === "Limited Edition Beta") {
          cardsetname = "Beta";
        } else if (setToAdd.name === "Unlimited Edition") {
          cardsetname = "Unlimited";
        } else if (setToAdd.name === "Revised Edition") {
          cardsetname = "3rd Edition";
        } else if (setToAdd.name === "Mystery Booster") {
          cardsetname = "Mystery Booster The List";
        } else if (setToAdd.code === "tfla") {
          cardsetname = "Avatar: The Last Airbender Front Cards";
        } else {
          cardsetname = setToAdd.name;
          cardsetname = cardsetname.replace(/"/g, "");
          cardsetname = cardsetname.replace(/'/g, "");
        }
        releasedate = setToAdd.released_at;
        iconsvguri = setToAdd.icon_svg_uri;
        cardset = setToAdd.code;

        // push the set into the array
        setsToAdd.push({ cardsetname, releasedate, iconsvguri, cardset });
      }

      // Calculate if this is the last iteration
      donePassing = maxIndexToInsert >= setsInformation.length;
      // If it is, add Strixhaven Mystical Archive Japanese as set
      if (donePassing) {
        setsToAdd.push({
          cardsetname: "Strixhaven Mystical Archive JPN",
          releasedate: "2021-04-23",
          iconsvguri: null,
          cardset: "staj",
        });
      }

      if (setsToAdd.length) {
        // Send the sets to the API
        const responseUpload = await fetch(apiUrl, {
          method: "POST",
          body: JSON.stringify({
            setsToAdd,
            deleteDatabase: maxIndexToInsert == batchNumber,
            sets: true,
          }),
          headers: {
            "Content-Type": "application/json",
          },
        });

        addedSets = addedSets + setsToAdd.length;
        maxIndexToInsert = maxIndexToInsert + batchNumber;
        if (responseUpload.status === 200) {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(`✅ ${addedSets} sets subidos ok`);
        }
      }
    }

    process.stdout.write("\n");
    maxIndexToInsert = batchNumber;

    process.stdout.write("🔄 Obteniendo URLs de ScryFall");
    const response = await fetch(scryfallUrl + bulkDataUri, {
      method: "GET",
      timeout: 30000,
    });

    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write("✅ Obteniendo URLs de ScryFall\n");
    const bulkLibraries = await response.json();
    // Once it has the bulk libraries, it finds the
    // unique_cards URL
    var bulkDataURL = null;
    bulkLibraries.data.forEach((bulkPack) => {
      if (bulkPack.type === "default_cards") {
        bulkDataURL = bulkPack.download_uri;
      }
    });
    console.log("✅ URL de default_cards: " + bulkDataURL);
    process.stdout.write("🔄 Descargando listado default_cards");
    // const responseCardDatabase = await fetch(bulkDataURL, {
    //   method: "GET",
    //   timeout: 200000,
    // });

    // console.log("✅ default_cards descargado");
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write("✅ Descargando listado default_cards\n");
    // const cardDatabase = await responseCardDatabase.json();

    const cardDatabase = JSON.parse(
      readFileSync(ROUTE_TO_LOCAL_FILE).toString()
    );

    // Sets the variables for each card to add to the array to send
    let name;
    let image;
    let borderless;
    let showcase;
    let phyrexian;
    let extendedart;
    let retroframe;
    let boxtopper;
    let releasedatyear;
    let color;
    let rarity;
    let collectornumber;
    let scryfallid;
    let cardsetcode;
    donePassing = false;
    //
    while (!donePassing) {
      let cardsToAdd = [];
      // Creates a batch of cards to upload
      for (
        let i = maxIndexToInsert - batchNumber;
        i < Math.min(maxIndexToInsert, cardDatabase.length);
        i++
      ) {
        const cardToAdd = cardDatabase[i];

        borderless = false;
        showcase = false;
        phyrexian = false;
        extendedart = false;
        retroframe = false;
        boxtopper = false;
        collectornumber = 0;
        // If the card is digital, ignore it
        if (!cardToAdd.digital) {
          // Load the card's data into variables
          scryfallid = cardToAdd.id;
          // If the name of the card or the set has a quotation mark, delete it
          name = cardToAdd.name.replace(/"/g, "");
          name = cardToAdd.name.replace(/'/g, "");
          if (cardToAdd.set_name.indexOf("Secret Lair") !== -1) {
            cardsetname = "Secret Lair";
            cardsetcode = "sld";
          } else if (cardToAdd.set_name === "Limited Edition Alpha") {
            cardsetname = "Alpha";
            cardsetcode = "lea";
          } else if (cardToAdd.set_name === "Limited Edition Beta") {
            cardsetname = "Beta";
            cardsetcode = "leb";
          } else if (cardToAdd.set_name === "Unlimited Edition") {
            cardsetname = "Unlimited";
            cardsetcode = "2ed";
          } else if (cardToAdd.set_name === "Revised Edition") {
            cardsetname = "3rd Edition";
            cardsetcode = "3ed";
          } else if (
            cardToAdd.set_name === "Strixhaven Mystical Archive" &&
            cardToAdd.lang === "ja"
          ) {
            cardsetname = "Strixhaven Mystical Archive JPN";
            cardsetcode = "staj";
          } else if (cardToAdd.set_name === "Mystery Booster") {
            cardsetname = "Mystery Booster The List";
            cardsetcode = cardToAdd.set;
          } else {
            cardsetname = cardToAdd.set_name.replace(/'/g, "");
            cardsetcode = cardToAdd.set;
          }
          releasedatyear = cardToAdd.released_at.match(/^\d{4}/);
          if (cardToAdd.colors) {
            color = cardToAdd.colors.sort(sortByWUBRG).join().replace(/,/g, "");
          }
          rarity = cardToAdd.rarity;
          collectornumber = cardToAdd.collector_number;
          // If the card has multiple faces, load the front one as the image
          if (cardToAdd.image_uris?.normal) {
            image = cardToAdd.image_uris?.normal;
          } else if (cardToAdd.card_faces[0]?.image_uris?.normal) {
            image = cardToAdd.card_faces[0].image_uris?.normal;
          }
          // Determine if the card has alterations
          if (
            cardToAdd.border_color &&
            cardToAdd.border_color?.indexOf("borderless") !== -1
          ) {
            borderless = true;
          }
          if (
            cardToAdd.frame_effects &&
            cardToAdd.frame_effects?.indexOf("showcase") !== -1
          ) {
            showcase = true;
          }
          if (cardToAdd.lang === "ph") {
            phyrexian = true;
          }
          if (
            cardToAdd.frame_effects &&
            cardToAdd.frame_effects?.indexOf("extendedart") !== -1
          ) {
            extendedart = true;
          }
          if (cardToAdd.frame === "1997") {
            retroframe = true;
          }
          if (
            cardToAdd.promo_types &&
            cardToAdd?.promo_types.indexOf("boxtopper") !== -1
          ) {
            boxtopper = true;
          }
          // Push the card into the array
          cardsToAdd.push({
            scryfallid,
            name,
            cardsetcode,
            cardsetname,
            image,
            releasedatyear,
            borderless,
            showcase,
            phyrexian,
            extendedart,
            retroframe,
            boxtopper,
            color,
            rarity,
            collectornumber,
          });
        }
      }
      if (cardsToAdd.length) {
        // Send the cards to the API
        const responseUpload = await fetch(apiUrl, {
          method: "POST",
          body: JSON.stringify({
            cardsToAdd,
            deleteDatabase: maxIndexToInsert == batchNumber,
            sets: false,
          }),
          headers: {
            "Content-Type": "application/json",
          },
        });
        if (responseUpload.status === 200) {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(`✅ ${addedCards} cartas subidas ok`);
        }
      }
      donePassing = maxIndexToInsert >= cardDatabase.length;
      addedCards = addedCards + cardsToAdd.length;
      maxIndexToInsert = maxIndexToInsert + batchNumber;
    }

    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`✅ ${addedCards} cartas subidas ok\n`);
  } catch (e) {
    console.log("error: " + e);
  }
}

getScryfallCollectionURL();
