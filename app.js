import express, { urlencoded } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pkg from "body-parser";
const { json } = pkg;
// Heroku injects PORT, so the fallback only ever applies locally. 3001 used to
// be the fallback and collided with an unrelated project on this machine, which
// made the API fail to boot with EADDRINUSE rather than anything informative.
const PORT = process.env.PORT || 3101;
import prisma from "./services/prisma.js";

import messages from "./data/messages.js";

const app = express();

// Heroku (and any reverse proxy) terminates TLS and forwards the real client
// IP in X-Forwarded-For. Trust one proxy hop so express-rate-limit keys on the
// actual client rather than lumping every user behind the proxy into one
// bucket (which would let one attacker rate-limit everybody, or exempt
// everybody). One hop, not `true`, so the header cannot be spoofed past it.
app.set("trust proxy", 1);

// Security headers (HSTS, X-Content-Type-Options, frame denial, etc.). The API
// serves only JSON, so the HTML-oriented CSP is off; CORP is set to
// cross-origin because the browser apps live on a different origin and fetch
// from here.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(
  urlencoded({
    // Cap urlencoded bodies too; the default is 100kb but making it explicit
    // keeps every body parser bounded.
    extended: true,
    limit: "100kb",
  })
);

// CORS. With an allowlist configured (CORS_ORIGINS, comma-separated) only those
// origins are accepted; with none set it stays open, matching the previous
// behaviour so nothing breaks before the origins are pinned in the Heroku
// config. Credentials are NOT enabled — auth is a bearer token in a header, not
// a cookie — so an open policy cannot be turned into a credentialed CSRF.
const corsAllowlist = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors(
    corsAllowlist.length
      ? {
          origin: (origin, cb) =>
            // Non-browser callers (curl, server-to-server) send no Origin and
            // are allowed; a browser Origin must be on the list.
            !origin || corsAllowlist.includes(origin)
              ? cb(null, true)
              : cb(new Error("Origin not allowed")),
        }
      : undefined
  )
);

// Pasa el objeto de prisma a todas las rutas
app.all("*", (req, res, next) => {
  req.prisma = prisma;
  next();
});

// parse application/json
// 2mb instead of the 100kb default: a ManaBox CSV of a large binder is a few
// hundred KB, and it arrives as one JSON field.
app.use(json({ limit: "2mb" }));

// Rate limiting. Auth endpoints get a tight limiter to blunt brute-force and
// credential-stuffing; the whole API gets a generous ceiling as a backstop
// against a single client hammering any one route. Counting is per client IP
// (see `trust proxy` above). `standardHeaders` returns RateLimit-* so a well
// behaved client can back off; failures answer JSON, not Express HTML.
const rateLimited = (max, windowMinutes) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: messages.TOO_MANY_REQUESTS },
  });

// Login and registration: a handful of attempts a minute is plenty for a real
// person and far below what a brute-force needs.
const authLimiter = rateLimited(20, 15);
// The bulk imports are expensive; keep them infrequent per client.
const importLimiter = rateLimited(10, 15);
// A wide backstop for everything else.
const globalLimiter = rateLimited(600, 15);

app.use(globalLimiter);
app.use("/oauth", authLimiter);
app.post("/player", authLimiter);
// The bulk-import endpoints, throttled harder because each call is expensive.
app.post("/storage/:id/import", importLimiter);
app.post("/mystorage/:id/import", importLimiter);
app.post("/wishlist/import-moxfield", importLimiter);

// Middleware for authentication
import { authentication, staff } from "./middleware/authentication.js";
app.use("/collection", authentication);
app.use("/sale", authentication);
app.use("/player/me", authentication);
app.use("/order", authentication);
app.use("/wishlist", authentication);
app.use("/notification", authentication);
app.use("/mystorage", authentication);
app.use("/cart", authentication);
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

// The customer's shopping cart — the confirmation step between wanting a card
// and the shop being asked to pull it.
import cartRoute from "./routes/cart.js";
app.use("/cart", cartRoute);

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
