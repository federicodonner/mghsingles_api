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

  console.log("login afuera: " + login);
  if (!login) {
    console.log("login adentro: " + login);
    console.log("chau");
    return res.status(403).json({ message: messages.UNAUTHORIZED });
  }

  // If the token is found, verifies if the player exists
  const player = await prisma.player.findUnique({
    where: { id: login.playerid },
  });

  // If the player doesn't exist, exit with error
  if (!player) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  // If the player exists, verifies if it's the latest login
  const verifyLatestToken = await prisma.login.findFirst({
    where: { playerid: player.id },
    orderBy: { date: "desc" },
  });

  // Verifies that the token in the last player login is the same
  if (verifyLatestToken.token !== token) {
    console.log("hola");
    return res.status(403).json({ message: messages.UNAUTHORIZED });
  }
  // If the login is correct and the player is found, the id
  // is passed to the route from the middleware
  req.playerId = player.id;
  next();
}

// Authentication for admin endpoints
// Verifies that the player is superuser
export async function superuser(req, res, next) {
  // Get the player id from the authentication middleware
  var playerId = req.playerId;

  // Gets prisma from middleware
  const prisma = req.prisma;

  // Check if the user is a superuser
  const player = await prisma.player.findUnique({
    where: { id: playerId, superuser: true },
  });

  // If the results is empty, it means that the user is not a superuser
  if (!player) {
    return res.status(403).json({ message: messages.UNAUTHORIZED });
  }
  // If the user exists and is a superuser, advance
  next();
}
