const { Client } = require("pg");

function connectDatabase() {
  const client = new Client({
    user: "fefi",
    host: "localhost",
    database: "mghsingles",
    password: "root",
    port: 5432,
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
