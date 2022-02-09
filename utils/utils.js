var fetch = require("cross-fetch");

// Returns a random string of the specified length
function generateToken(
  length,
  universe = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
) {
  var result = "";
  for (var i = 0; i < length; i++) {
    result += universe.charAt(Math.floor(Math.random() * universe.length));
  }
  return result;
}

// Access external URL
async function accessURL(url) {
  var fetchPromise = await fetch(url, { method: "GET", timeout: 30000 });
  return fetchPromise;
}

async function accessURLDOS(url) {
  console.log("estoy");
  fetch(
    "https://c2.scryfall.com/file/scryfall-bulk/default-cards/default-cards-20220209100300.json",
    { method: "GET" }
  ).then((response) => {
    response.json().then((data) => {
      console.log(data);
    });
  });
}
module.exports = { generateToken, accessURL, accessURLDOS };
