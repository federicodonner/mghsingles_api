// Route file for getting and editing gastos
import { Router } from "express";
var router = Router();
import { compare, hashSync } from "bcrypt";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import { generateToken } from "../utils/utils.js";

// A valid throwaway hash, computed once at boot. Comparing against it when no
// account matches keeps the failure path the same shape (and roughly the same
// duration) as a real wrong-password, so login timing does not reveal which
// usernames exist.
const THROWAWAY_HASH = hashSync("no-such-account", 12);

// Validate the user and return the token.
//
// Login is by EMAIL (2026-09-02, Federico — usernames were retired). The
// `email` field carries it; `username` is still read as a fallback so a cached
// old client keeps working. Case does not matter: nobody should be locked out
// over a shift key.
router.post("/", asyncHandler(async (req, res) => {
  // Loads the data into variables to use. `password` is coerced to a string:
  // a JSON body of `{"password":{...}}` would otherwise reach bcrypt.compare
  // as an object and throw a 500 that doubles as an error oracle.
  var identifier = String(req.body.email ?? req.body.username ?? "").trim();
  var password = typeof req.body.password === "string" ? req.body.password : "";

  // Validates that all the compulsory fields are present
  if (!identifier || !password) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }

  // Gets prisma from the middleware
  const prisma = req.prisma;

  // By email — the one login identifier now.
  const player = await prisma.player.findFirst({
    where: { email: { equals: identifier, mode: "insensitive" } },
  });

  // A wrong username and a wrong password give the SAME answer, so an attacker
  // cannot enumerate which accounts exist by watching for 404-vs-401. Both are
  // the generic "bad credentials" 401. When the user is missing we still run a
  // bcrypt compare against a throwaway hash so the response time does not leak
  // the account's existence either.
  const passwordResult = await compare(
    password,
    player ? player.passwordhash : THROWAWAY_HASH
  );
  if (!player || !passwordResult) {
    return res.status(401).json({ message: messages.INCORRECT_CREDENTIALS });
  }

  // The UI needs to know what this account may do, so it can send a customer
  // to the store and a shop hand to the back office.
  let role = player.role;

  // Generate the login record with the token
  var token = generateToken(25);
  const newToken = await prisma.login.create({
    data: { date: new Date(), playerid: player.id, token },
  });
  return res.status(200).json({ token: newToken.token, role });
}));

// Log out: destroy the presented token server-side.
//
// Until this existed, "logging out" only dropped the token from the browser's
// localStorage while the row stayed valid in the database forever — a token
// captured from a shared computer or a log kept working. This deletes exactly
// the token in the Authorization header, so other devices' sessions are left
// alone. It answers 200 whether or not the token was found: telling a caller
// "that token did not exist" is an oracle with no upside.
router.delete("/", asyncHandler(async (req, res) => {
  const header = String(req.header("authorization") ?? "").split(" ");
  const token = header[0] === "Bearer" ? header[1] : null;
  if (token) {
    await req.prisma.login.deleteMany({ where: { token } });
  }
  return res.status(200).json({ message: messages.LOGGED_OUT });
}));

export default router;
