// Authentication middleware
import messages from "../data/messages.js";

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
export const owner = requireRole(["owner"]);
