// Route file for getting and editing users
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import { hash as _hash, compare } from "bcrypt";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import { generateToken } from "../utils/utils.js";
import { creditFor, ZERO as CREDIT_ZERO } from "../services/credit.js";
import { buildPlayerHistory } from "../services/playerHistory.js";

// Password policy, shared by register and change-password. bcrypt only reads
// the first 72 bytes, so the upper bound is about rejecting a multi-megabyte
// string rather than a security limit; the lower bound is the real control.
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const passwordProblem = (pw) =>
  typeof pw !== "string" || pw.length < PASSWORD_MIN || pw.length > PASSWORD_MAX;

// Work factor for bcrypt. 8 was below the modern floor; 12 is the common
// recommendation. `compare` reads the cost from the stored hash, so old
// hashes keep verifying and re-hash to 12 only when the password is changed.
const BCRYPT_COST = 12;

// Create a new user
router.post(
  "/",
  [check("name").escape(), check("email").isEmail()],
  asyncHandler(async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      // Verifies if the error is the email
      if (errors.errors[0].param === "email") {
        return res.status(400).json({ message: messages.EMAIL_ERROR });
      } else {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
    }
    // Loads the data into variables to use. No username any more — the email
    // is the account's only identifier.
    var name = req.body.name;
    var email = req.body.email.toLowerCase();
    var password = req.body.password;

    // Validates that all the compulsory fields are present
    if (!name || !email || !password) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // A minimum password length, enforced on the server so a customer cannot
    // set a one-character password by calling the API directly.
    if (passwordProblem(password)) {
      return res.status(400).json({ message: messages.PASSWORD_TOO_SHORT });
    }

    // Gets prisma from middleware
    const prisma = req.prisma;
    try {
      // The email must be free: whoever owns it already has an account and
      // should log in. Case-insensitive — the address is stored lowercased.
      // The @unique constraint below catches any race.
      const emailTaken = await prisma.player.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (emailTaken) {
        return res.status(400).json({ message: messages.EMAIL_REPEAT });
      }

      // Hash the password
      const passwordhash = await _hash(password, BCRYPT_COST);
      // Adds the user to the database (no username).
      const newPlayer = await prisma.player.create({
        data: { name, email, passwordhash },
      });

      // After the user is inserted, create a collection and add it to it
      // The new player id is returned from the insert statement.
      // 0.25 = the shop's standard consignment cut (was 0.30 until 2026-09-02).
      const newCollection = await prisma.collection.create({
        data: { playerid: newPlayer.id, percent: 0.25 },
      });

      // After the user is inserted, create a login record and return it
      var token = generateToken(25);
      const newToken = await prisma.login.create({
        data: { date: new Date(), playerid: newPlayer.id, token },
      });

      // Add the generated token to the response
      res.status(201).send({ token });
    } catch (e) {
      // Two registrations racing past the email check land here: the unique
      // constraint rejects the loser. Email is the only unique field a new
      // account sets now, so the collision is always the email.
      if (e?.code === "P2002") {
        return res.status(400).json({ message: messages.EMAIL_REPEAT });
      }
      // Anything unexpected is logged server-side but never returned: the raw
      // Prisma error object leaked table and column names to the client.
      console.error("register failed:", e);
      return res.status(500).json({ message: messages.SERVER_ERROR });
    }
  })
);

// Update user details
router.put(
  "/",
  [check("name").escape().optional(), check("email").isEmail().optional()],
  asyncHandler(async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      // Verifies if the error is the email
      if (errors.errors[0].param === "email") {
        return res.status(400).json({ message: messages.EMAIL_ERROR });
      } else {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
    }
    // Get the userId from the authentication middleware. requirePlayerId
    // throws rather than letting an absent id degrade the Prisma `where` into
    // "match anyone".
    var playerId = requirePlayerId(req);

    // Get the new data from the body
    var name = req.body.name;
    var email = req.body.email;
    // Phone is optional and free-form (people write it however they like); an
    // empty string clears it.
    var phone = req.body.phone;

    // If there is no data, return error
    if (!name && !email && phone === undefined) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // This used to build the UPDATE by string concatenation against a `client`
    // that is never imported, so the route threw ReferenceError on every call.
    // Had it worked it would have been an injection: `check().escape()` escapes
    // HTML entities, not SQL quotes.
    const data = {};
    if (name) data.name = name;
    if (email) data.email = email.toLowerCase();
    if (phone !== undefined) data.phone = phone ? String(phone).trim() : null;

    // A changed email must not collide with anybody else's — email is unique
    // and doubles as a login identifier.
    if (data.email) {
      const emailTaken = await req.prisma.player.findFirst({
        where: {
          email: { equals: data.email, mode: "insensitive" },
          NOT: { id: playerId },
        },
        select: { id: true },
      });
      if (emailTaken) {
        return res.status(400).json({ message: messages.EMAIL_REPEAT });
      }
    }

    try {
      const updated = await req.prisma.player.update({
        where: { id: playerId },
        data,
        select: { id: true, name: true, email: true, phone: true },
      });
      return res.status(200).json(updated);
    } catch (e) {
      // The unique constraint catches a race past the check above.
      if (e?.code === "P2002") {
        return res.status(400).json({ message: messages.EMAIL_REPEAT });
      }
      throw e;
    }
  })
);

// Update user password
router.put("/password", asyncHandler(async (req, res) => {
  // Get the userId from the authentication middleware
  var playerId = requirePlayerId(req);

  // Get the new data from the body
  var password = req.body.password;
  var newPassword = req.body.newPassword;

  // If there is no data, return error
  if (!password || !newPassword) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }

  // The new password must meet the same policy as at registration.
  if (passwordProblem(newPassword)) {
    return res.status(400).json({ message: messages.PASSWORD_TOO_SHORT });
  }

  // Same story as PUT / above: raw SQL against a `client` that does not exist,
  // plus an assignment to an undeclared `hashedPassword`, which throws outright
  // in a module. Nobody could change their password.
  const player = await req.prisma.player.findUnique({ where: { id: playerId } });
  if (!player) {
    return res.status(404).json({ message: messages.USER_NOT_FOUND });
  }

  if (!(await compare(password, player.passwordhash))) {
    return res.status(400).json({ message: messages.INCORRECT_PASSWORD });
  }

  await req.prisma.player.update({
    where: { id: playerId },
    data: { passwordhash: await _hash(newPassword, BCRYPT_COST) },
  });

  return res.status(200).json({ message: messages.USER_UPDATED });
}));

// Return user's details based on the token
router.get("/me", asyncHandler(async (req, res) => {
  // Gets the userId from the authentication middleware
  var playerId = req.playerId;

  // Gets prisma from middleware
  const prisma = req.prisma;

  const player = await prisma.player.findUnique({
    where: { id: playerId },
    include: { collection: { select: { id: true } } },
  });

  // If there are no results, return error
  if (!player) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }

  // Their spendable store credit (dollars) — the sum of what the store owes
  // them across their collections, minus what they have already drawn. The
  // account screen shows it in pesos.
  let credit = CREDIT_ZERO;
  for (const c of player.collection) {
    credit = credit.add(await creditFor(prisma, c.id));
  }

  // If there is a user, return it
  delete player.passwordhash;
  delete player.id;
  delete player.collection;
  return res.status(200).json({ ...player, credit: credit.toFixed(2) });
}));

// The signed-in customer's own activity, same shape and ordering as the admin's
// per-customer history — both read services/playerHistory.js.
router.get("/me/history", asyncHandler(async (req, res) => {
  const history = await buildPlayerHistory(req.prisma, req.playerId);
  if (!history) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }
  return res.status(200).json(history);
}));

export default router;
