const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 3001;

const app = express();
app.use(
  express.urlencoded({
    extended: true,
  })
);

// Middleware for cors
app.use(cors());

// parse application/json
app.use(bodyParser.json());

// Middleware for authentication
var authenticationMiddleware = require("./middleware/authentication");
app.use("/collection", authenticationMiddleware.authentication);
app.use("/sale", authenticationMiddleware.authentication);
app.use("/player/me", authenticationMiddleware.authentication);
app.put("/player", authenticationMiddleware.authentication);
app.put("/player/password", authenticationMiddleware.authentication);
app.delete("/card/:cardId", authenticationMiddleware.authentication);
app.post("/card", authenticationMiddleware.authentication);

// Middleware for superuser authentication
app.use("/admin", [
  authenticationMiddleware.authentication,
  authenticationMiddleware.superuser,
]);

// Routes for oauth
var oauthRoute = require("./routes/oauth");
app.use("/oauth", oauthRoute);

// Routes for getting bulk cards
var bulkRoute = require("./routes/processBulk");
app.use("/bulk", bulkRoute);

// Routes for user operations
var playerRoute = require("./routes/player");
app.use("/player", playerRoute);

// Routes for collection operations
var collectionRoute = require("./routes/collection");
app.use("/collection", collectionRoute);

// Routes for sale operations
var saleRoute = require("./routes/sale");
app.use("/sale", saleRoute);

// Routes for card operations
var cardRoute = require("./routes/card");
app.use("/card", cardRoute);

// Routes for store operations
var storeRoute = require("./routes/store");
app.use("/store", storeRoute);

// Routes for admin operations
var adminRoute = require("./routes/admin");
app.use("/admin", adminRoute);

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
