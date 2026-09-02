// Authentication middleware
import messages from "../data/messages.js";

// Optional session lifetime. Unset (or non-positive) keeps the historical
// behaviour — a token is valid until logout — so turning this on is a
// deliberate config choice. Set TOKEN_TTL_DAYS to a positive number and any
// token older than that stops working, which bounds the damage of a leaked
// token to that window.
const ttlDays = Number(process.env.TOKEN_TTL_DAYS);
const TOKEN_TTL_MS =
  Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays * 86400 * 1000 : null;

export async function authentication(req, res, next) {
  // Verifies that the authorization header exists
  if (!req.header("authorization")) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }
  // If the structure is not "Bearer [accesstoken] return error"
  let authorizationHeader = req.header("authorization").split(" ");
  if (authorizationHeader[0] !== "Bearer" && authorizationHeader.length != 2) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  let token = authorizationHeader[1];

  // If there is no token return unauthenticated
  if (!token) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  // Gets prisma from middleware
  const prisma = req.prisma;

  // Check if the token is in the database
  const login = await prisma.login.findFirst({
    where: { token },
    orderBy: { date: "desc" },
  });

  if (!login) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  // If a session lifetime is configured, an aged token is treated as absent.
  if (TOKEN_TTL_MS !== null) {
    const age = Date.now() - new Date(login.date).getTime();
    if (age > TOKEN_TTL_MS) {
      return res.status(401).json({ message: messages.UNAUTHORIZED });
    }
  }

  // If the token is found, verifies if the player exists
  const player = await prisma.player.findUnique({
    where: { id: login.playerid },
  });

  // If the player doesn't exist, exit with error
  if (!player) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  // Any token from a real login is good: sessions coexist, so signing in on a
  // second device (or a test harness signing in as you) does not kick the
  // first one out. This used to reject everything but the LATEST login, which
  // read as "the app keeps logging me out" to anybody with two sessions.
  //
  // If the login is correct and the player is found, the id
  // is passed to the route from the middleware
  req.playerId = player.id;
  next();
}

// Like `authentication`, but never rejects: if a valid token is present it sets
// req.playerId, otherwise it just continues. For the public storefront, which
// serves logged-out shoppers but wants to recognise a logged-in customer's own
// cards ("es tuya") when a token happens to be sent.
export async function optionalAuthentication(req, res, next) {
  const header = req.header("authorization");
  const parts = header ? header.split(" ") : [];
  const token = parts[0] === "Bearer" ? parts[1] : null;
  if (token) {
    const login = await req.prisma.login.findFirst({
      where: { token },
      orderBy: { date: "desc" },
    });
    if (login) {
      const player = await req.prisma.player.findUnique({
        where: { id: login.playerid },
      });
      if (player) req.playerId = player.id;
    }
  }
  next();
}

// Role gates for the shop side.
//
// `staff` covers everything a shop hand does: selling, stock, storage, orders.
// `owner` is staff plus the things that should not be delegated casually —
// payouts, pricing policy and who gets which role.
//
// Both run AFTER `authentication`, which is what sets req.playerId.
function requireRole(allowed) {
  return async function (req, res, next) {
    const playerId = req.playerId;
    const prisma = req.prisma;

    const player = await prisma.player.findUnique({
      where: { id: playerId },
      select: { role: true },
    });

    // Same 403 and message whichever gate refused, so a staff member probing an
    // owner route learns nothing about what exists.
    if (!player || !allowed.includes(player.role)) {
      return res.status(403).json({ message: messages.UNAUTHORIZED });
    }

    // Downstream handlers frequently need the role; save them a lookup.
    req.playerRole = player.role;
    next();
  };
}

export const staff = requireRole(["staff", "owner"]);
// TEMPORARY (2026-09-02, Federico): staff and owner can both do everything —
// the owner-only gate now admits staff too. The `owner` export is kept so the
// routes that should later be owner-only (payouts, pricing policy, roles) stay
// marked and can be tightened back by making this `["owner"]` again, without
// hunting for the call sites.
export const owner = requireRole(["staff", "owner"]);
