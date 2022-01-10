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

module.exports = { generateToken, accessURL };
