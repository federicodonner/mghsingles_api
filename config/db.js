const { Client } = require("pg");

function connectDatabase() {
  console.log(
    process.env.DB_USER,
    process.env.DB_HOST,
    process.env.DB_DATABASE,
    process.env.DB_PASSWORD,
    process.env.DB_PORT
  );
  const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
  });
  client.connect((err) => {
    if (!err) {
      console.log("Database connected");
    } else {
      console.log("Error connecting to database");
    }
  });

  return client;
}
module.exports = connectDatabase();
