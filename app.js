import express, { urlencoded } from "express";
import cors from "cors";
import pkg from "body-parser";
const { json } = pkg;
const PORT = process.env.PORT || 3001;
import { PrismaClient } from "@prisma/client";

import messages from "./data/messages.js";

const app = express();
const prisma = new PrismaClient();

app.use(
  urlencoded({
    extended: true,
  })
);

// Middleware for cors
app.use(cors());

// Pasa el objeto de prisma a todas las rutas
app.all("*", (req, res, next) => {
  req.prisma = prisma;
  next();
});

// parse application/json
app.use(json());

// Middleware for authentication
import { authentication, superuser } from "./middleware/authentication.js";
app.use("/collection", authentication);
app.use("/sale", authentication);
app.use("/player/me", authentication);
app.put("/player", authentication);
app.put("/player/password", authentication);
// NOTE: /card is deliberately NOT listed here. Registering auth by path from
// this file is fragile — `app.post("/card", ...)` matched only the exact path
// while the real route is `/card/:collectionId`, leaving card creation fully
// unauthenticated. routes/card.js now attaches `authentication` to each route
// that needs it, so renaming a path cannot silently drop its auth.

// Middleware for superuser authentication
app.use("/admin", [authentication, superuser]);
app.use("/storage", [authentication, superuser]);
app.use("/find", [authentication, superuser]);

// Routes for oauth
import oauthRoute from "./routes/oauth.js";
app.use("/oauth", oauthRoute);

// Routes for user operations
import playerRoute from "./routes/player.js";
app.use("/player", playerRoute);

// Routes for collection operations
import collectionRoute from "./routes/collection.js";
app.use("/collection", collectionRoute);

// Routes for sale operations
import saleRoute from "./routes/sale.js";
app.use("/sale", saleRoute);

// Routes for card operations
import cardRoute from "./routes/card.js";
app.use("/card", cardRoute);

// Routes for store operations
import storeRoute from "./routes/store.js";
app.use("/store", storeRoute);

// Routes for admin operations
import adminRoute from "./routes/admin.js";
app.use("/admin", adminRoute);

// Routes for physical storage (binders and boxes)
import storageRoute from "./routes/storage.js";
app.use("/storage", storageRoute);

// Routes for locating a card in the shop
import findRoute from "./routes/find.js";
app.use("/find", findRoute);

// 404 for anything no route matched, so the client gets JSON rather than
// Express's HTML error page.
app.use((req, res) => {
  res.status(404).json({ message: messages.NOT_FOUND });
});

// Error handler. Must be last and must take four arguments — that arity is how
// Express recognises it. Combined with asyncHandler in the routes, this
// guarantees a throwing handler returns 500 instead of hanging the request and
// taking the process down with it.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.originalUrl} failed:`, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ message: messages.SERVER_ERROR });
});

// Last-resort guards. Nothing should reach these now that handlers are
// wrapped, but a crash here is logged rather than silent.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

app.listen(PORT, () => console.log(`Listening on ${PORT}`));
