const { Client } = require("pg");

function connectDatabase() {
  const client = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DBPASSWORD,
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
