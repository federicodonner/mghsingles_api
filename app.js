import express, { urlencoded } from "express";
import cors from "cors";
import pkg from "body-parser";
const { json } = pkg;
// Heroku injects PORT, so the fallback only ever applies locally. 3001 used to
// be the fallback and collided with an unrelated project on this machine, which
// made the API fail to boot with EADDRINUSE rather than anything informative.
const PORT = process.env.PORT || 3101;
import prisma from "./services/prisma.js";

import messages from "./data/messages.js";

const app = express();

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
// 2mb instead of the 100kb default: a ManaBox CSV of a large binder is a few
// hundred KB, and it arrives as one JSON field.
app.use(json({ limit: "2mb" }));

// Middleware for authentication
import { authentication, staff } from "./middleware/authentication.js";
app.use("/collection", authentication);
app.use("/sale", authentication);
app.use("/player/me", authentication);
app.use("/order", authentication);
app.use("/wishlist", authentication);
app.use("/notification", authentication);
app.use("/mystorage", authentication);
app.put("/player", authentication);
app.put("/player/password", authentication);
// NOTE: /card is deliberately NOT listed here. Registering auth by path from
// this file is fragile — `app.post("/card", ...)` matched only the exact path
// while the real route is `/card/:collectionId`, leaving card creation fully
// unauthenticated. routes/card.js now attaches `authentication` to each route
// that needs it, so renaming a path cannot silently drop its auth.

// Role gates for the shop side.
//
// Everything under /admin and /storage needs at least staff. The handful
// of owner-only routes are marked individually in routes/admin.js rather than
// here, so the rule sits next to the thing it protects and a renamed path
// cannot quietly lose its gate — the same lesson as /card above.
app.use("/admin", [authentication, staff]);
app.use("/storage", [authentication, staff]);

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

// Routes for customer reservations and wishlists
import orderRoute from "./routes/order.js";
app.use("/order", orderRoute);

import wishlistRoute from "./routes/wishlist.js";
app.use("/wishlist", wishlistRoute);

import notificationRoute from "./routes/notification.js";
app.use("/notification", notificationRoute);

// Routes for physical storage (binders and boxes)
import storageRoute from "./routes/storage.js";
import mystorageRoute from "./routes/mystorage.js";
app.use("/storage", storageRoute);

// A customer's own binders and boxes: their half of the retire/release cycle.
app.use("/mystorage", mystorageRoute);

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
