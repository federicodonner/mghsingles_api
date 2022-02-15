const { Client } = require("pg");

function connectDatabase() {
  var client;
  if (process.env.NODE_ENV !== "production") {
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
    });
  } else {
    client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false,
      },
    });
  }
  client.connect((err) => {
    if (!err) {
      console.log("Database connected");
    } else {
      console.log("Error connecting to database", err);
    }
  });

  return client;
}
module.exports = connectDatabase();
