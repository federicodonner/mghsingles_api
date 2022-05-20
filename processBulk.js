const http = require("http");
const https = require("https");
var fetch = require("cross-fetch");
// First, the route receives the request and pings Scryfall
// looking for the URL of the data bulk
async function getScryfallCollectionURL() {



  const scryfallUrl = "http://api.scryfall.com";
  const bulkDataUri = '/bulk-data';
  const setsUri = '/sets';

  // Verify if the --dev flag is entered and set URLs accordingly
  let apiUrl;
  if(process.argv.slice(2)[0]=='--dev'){
    apiUrl = "http://localhost:3001/bulk";
    console.log("⚠️  Modo developper seleccionado");
    console.log("⚠️  Guardando en base de datos local");
  }else{
    apiUrl = "http://mghsingles.herokuapp.com/bulk";
  }
  const batchNumber = 250;
  let maxIndexToInsert = batchNumber;
  let addedCards = 0;
  let addedSets = 0;

  console.log("ℹ️  Iniciando importación");
  console.log('🔄 Descargando sets');

  try {
  // Import the sets information

    const setsResponse = await fetch(scryfallUrl+setsUri, {
      method: "GET",
      timeout: 30000,
    });

    let setsInformation = await setsResponse.json();
    setsInformation = setsInformation.data;

  console.log('✅ Sets descargados');

    // Sets the variables for each card to add to the array to send
    let cardsetname;
    let releasedate;
    let iconsvguri;
    let cardset;
    let donePassing = false;

    while (!donePassing) {
       var setsToAdd=[];
      // Creates a batch of sets to upload
      for (
        var i = maxIndexToInsert - batchNumber;
        i < Math.min(maxIndexToInsert, setsInformation.length);
        i++
      ) {
          setToAdd = setsInformation[i];
          cardsetname = setToAdd.name;
          cardsetname = cardsetname.replace(/"/g, "");
          cardsetname = cardsetname.replace(/'/g, "");
          releasedate = setToAdd.released_at;
          iconsvguri = setToAdd.icon_svg_uri;
          cardset = setToAdd.code;

          // push the set into the array
          setsToAdd.push({cardsetname, releasedate, iconsvguri, cardset});
        }
      if (setsToAdd.length) {
        // Send the sets to the API
        const responseUpload = await fetch(apiUrl, {
          method: "POST",
          body: JSON.stringify({
            setsToAdd,
            deleteDatabase: maxIndexToInsert == batchNumber,
            sets:true,
          }),
          headers: {
            "Content-Type": "application/json",
          },
        });
        if (responseUpload.status === 200) {
          console.log("✅ " + setsToAdd.length + " sets subidos ok");
        }
      }
      donePassing = maxIndexToInsert >= setsInformation.length;
      addedSets = addedSets + setsToAdd.length;
      maxIndexToInsert = maxIndexToInsert + batchNumber;
      }

 maxIndexToInsert = batchNumber;
    
  console.log("🔄 Obteniendo URLs de ScryFall");
    const response = await fetch(scryfallUrl+bulkDataUri, {
      method: "GET",
      timeout: 30000,
    });

    console.log("✅ URLs obtenidas");
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
    console.log("🔄 Descargando listado default_cards");
    const responseCardDatabase = await fetch(bulkDataURL, {
      method: "GET",
      timeout: 60000,
    });
    console.log("✅ default_cards descargado");
    const cardDatabase = await responseCardDatabase.json();

    // Sets the variables for each card to add to the array to send
    let name;
    let image;
    donePassing = false;

    //
    while (!donePassing) {
      var cardsToAdd = [];
      // Creates a batch of cards to upload
      for (
        var i = maxIndexToInsert - batchNumber;
        i < Math.min(maxIndexToInsert, cardDatabase.length);
        i++
      ) {
        var cardToAdd = cardDatabase[i];

        // If the card is digital, ignore it
        if (!cardToAdd.digital) {
          // Load the card's data into variables
          scryfallid = cardToAdd.id;
          // If the name of the card or the set has a quotation mark, delete it
          name = cardToAdd.name.replace(/"/g, "");
          name = cardToAdd.name.replace(/'/g, "");
          cardsetname = cardToAdd.set_name.replace(/'/g, "");
          cardset = cardToAdd.set;
          // If the card has multiple faces, load the front one as the image
          if (cardToAdd.image_uris?.normal) {
            image = cardToAdd.image_uris?.normal;
          } else if (cardToAdd.card_faces[0]?.image_uris?.normal) {
            image = cardToAdd.card_faces[0].image_uris?.normal;
          }
          // Push the card into the array
          cardsToAdd.push({
            scryfallid,
            name,
            cardset,
            cardsetname,
            image,
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
          }),
          headers: {
            "Content-Type": "application/json",
          },
        });
        if (responseUpload.status === 200) {
          console.log("✅ " + cardsToAdd.length + " cartas subidas ok");
        }
      }
      donePassing = maxIndexToInsert >= cardDatabase.length;
      addedCards = addedCards + cardsToAdd.length;
      maxIndexToInsert = maxIndexToInsert + batchNumber;
    }
    console.log("--------");
    console.log("✅ " + addedCards + " cartas añadidas");
  
  } catch (e) {
    console.log("error: " + e);
  }
}

getScryfallCollectionURL();
