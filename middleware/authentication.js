// Authentication middleware
var client = require("../config/db.js");
var messages = require("../data/messages.js");

async function authentication(req, res, next) {
  // Verifies that the authorization header exists
  if (!req.header("authorization")) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }
  // If the structure is not "Bearer [accesstoken] return error"
  let authorizationHeader = req.header("authorization").split(" ");
  if (authorizationHeader[0] !== "Bearer" && authorizationHeader.length != 2) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  let loginToken = authorizationHeader[1];
  let userId = null;
  // If there is no token return unauthenticated
  if (!loginToken) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  // Check if the token is in the database
  let sql =
    "SELECT * FROM login WHERE token = '" +
    loginToken +
    "' ORDER BY date DESC LIMIT 1";
  let tokenResults = await client.query(sql);
  if (tokenResults.err) {
    throw tokenResults.err;
  }
  if (!tokenResults.rows.length) {
    return res.status(403).json({ message: messages.UNAUTHORIZED });
  }
  // If the token is found, verifies if the player exists
  playerId = tokenResults.rows[0].playerid;
  sql = "SELECT * FROM player WHERE id = " + playerId;
  let playerResults = await client.query(sql);
  if (playerResults.err) {
    throw playerResults.err;
  }
  // If the player doesn't exist, exit with error
  if (!playerResults.rows.length) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }
  // If the player exists, verifies if it's the latest login
  sql =
    "SELECT token FROM login WHERE playerid = " +
    playerId +
    " ORDER BY date DESC LIMIT 1";
  let results = await client.query(sql);
  if (results.err) {
    throw results.err;
  }
  // Verifies that the token in the last player login is the same
  if (results.rows[0].token !== loginToken) {
    return res.status(403).json({ message: messages.UNAUTHORIZED });
  }
  // If the login is correct and the player is found, the id
  // is passed to the route from the middleware
  req.playerId = playerId;
  next();
}

// Authentication for admin endpoints
// Verifies that the user is superuser
function superuser(req, res, next) {
  // Get the user id from the authentication middleware
  var userId = req.userId;

  // Check if the user is a superuser
  let sql = "SELECT * FROM user WHERE id = " + userId + " AND superuser = 1";
  let query = db.query(sql, (err, users) => {
    if (err) {
      throw err;
    }
    // If the results is empty, it means that the user is not a superuser
    if (!users.length) {
      return res.status(403).json({ message: messages.UNAUTHORIZED });
    }
    // If the user exists and is a superuser, advance
    next();
  });
}

module.exports = { authentication, superuser };
