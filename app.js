const express = require("express");
const mysql = require("mysql");
const cors = require("cors");
const bodyParser = require("body-parser");

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
app.use("/user/me", authenticationMiddleware.authentication);
app.put("/user", authenticationMiddleware.authentication);
app.put("/user/password", authenticationMiddleware.authentication);
app.use("/card/:cardId", authenticationMiddleware.authentication);
app.use("/payment", authenticationMiddleware.authentication);

// Routes for oauth
var oauthRoute = require("./routes/oauth");
app.use("/oauth", oauthRoute);

// Routes for getting bulk cards
var bulkRoute = require("./routes/processBulk");
app.use("/bulk", bulkRoute);

// Routes for user operations
var userRoute = require("./routes/user");
app.use("/user", userRoute);

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

// Routes for payment operations
var paymentRoute = require("./routes/payment");
app.use("/payment", paymentRoute);

app.listen("3001", () => {
  console.log("server started on port 3001");
});
