const express = require("express");
const mysql = require("mysql");
const cors = require("cors");

const app = express();
app.use(
  express.urlencoded({
    extended: true,
  })
);

// Middleware for cors
app.use(cors());

// Middleware for authentication
// var authenticationMiddleware = require("./middleware/authentication");
// app.use("/", authenticationMiddleware.authentication);

// Routes for oauth
var oauthRoute = require("./routes/oauth");
app.use("/oauth", oauthRoute);

// Routes for getting bulk cards
var bulkRoute = require("./routes/processBulk");
app.use("/bulk", bulkRoute);

// Routes for user operations
var userRoute = require("./routes/user");
app.use("/user", userRoute);

app.listen("3001", () => {
  console.log("server started on port 3001");
});
