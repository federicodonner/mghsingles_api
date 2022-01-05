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

// Routes for casa operations
var oauthRoute = require("./routes/oauth");
app.use("/oauth", oauthRoute);

app.listen("3001", () => {
  console.log("server started on port 3001");
});
