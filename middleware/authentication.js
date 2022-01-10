// Authentication middleware
var db = require("../config/db.js");
var messages = require("../data/messages.js");

function authentication(req, res, next) {
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
  let query = db.query(sql, (err, tokenResults) => {
    if (err) {
      throw err;
    }
    if (!tokenResults.length) {
      return res.status(403).json({ message: messages.UNAUTHORIZED });
    }
    // If the token is found, verifies if the user exists
    userId = tokenResults[0].userId;
    sql = "SELECT * FROM user WHERE id = " + userId;
    query = db.query(sql, (err, userResults) => {
      if (err) {
        throw err;
      }
      // If the user doesn't exist, exit with error
      if (!userResults.length) {
        return res.status(401).json({ message: messages.UNAUTHORIZED });
      }
      // If the user exists, verifies if it's the latest login
      sql =
        "SELECT token FROM login WHERE userId = " +
        userId +
        " ORDER BY date DESC LIMIT 1";
      query = db.query(sql, (err, results) => {
        if (err) {
          throw err;
        }
        // Verifies that the token in the last user login is the same
        if (results[0].token !== loginToken) {
          return res.status(403).json({ message: messages.UNAUTHORIZED });
        }
        // If the login is correct and the user is found, the id
        // is passed to the route from the middleware
        req.userId = userId;
        next();
      });
    });
  });
}

module.exports = { authentication };
