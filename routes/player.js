// Route file for getting and editing users
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import { hash as _hash, compare } from "bcrypt";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import { generateToken } from "../utils/utils.js";

// Create a new user
router.post(
  "/",
  [
    check("username").escape(),
    check("name").escape(),
    check("email").isEmail(),
  ],
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
    // Loads the data into variables to use
    var username = String(req.body.username ?? "").trim();
    var name = req.body.name;
    var email = req.body.email.toLowerCase();
    var password = req.body.password;

    // Validates that all the compulsory fields are present
    if (!username || !name || !email || !password) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Validates that the username has no spaces
    if (username.indexOf(" ") !== -1) {
      return res.status(400).json({ message: messages.USERNAME_INCORRECT });
    }

    // Gets prisma from middleware
    const prisma = req.prisma;
    try {
      // Both identifiers must be free, and each refusal names the field: a
      // person who owns the email already has an account and should log in;
      // a person whose username is taken just picks another. Checked
      // case-insensitively — "Ana" and "ana" would be indistinguishable at
      // the counter. The @unique constraints below catch any race.
      const usernameTaken = await prisma.player.findFirst({
        where: { username: { equals: username, mode: "insensitive" } },
        select: { id: true },
      });
      if (usernameTaken) {
        return res.status(400).json({ message: messages.USERNAME_REPEAT });
      }
      const emailTaken = await prisma.player.findFirst({
        where: { email: { equals: email, mode: "insensitive" } },
        select: { id: true },
      });
      if (emailTaken) {
        return res.status(400).json({ message: messages.EMAIL_REPEAT });
      }

      // Hash the password
      const passwordhash = await _hash(password, 8);
      // Adds the user to the database
      const newPlayer = await prisma.player.create({
        data: { username, name, email, passwordhash },
      });

      // After the user is inserted, create a collection and add it to it
      // The new player id is returned from the insert statement
      const newCollection = await prisma.collection.create({
        data: { playerid: newPlayer.id, percent: 0.3 },
      });

      // After the user is inserted, create a login record and return it
      var token = generateToken(25);
      const newToken = await prisma.login.create({
        data: { date: new Date(), playerid: newPlayer.id, token },
      });

      // Add the generated token to the response
      res.status(201).send({ token });
    } catch (e) {
      // Two registrations racing past the checks above land here: the unique
      // constraint rejects the loser, and the target says which field to blame.
      if (e?.code === "P2002") {
        const target = String(e.meta?.target ?? "");
        return res.status(400).json({
          message: target.includes("email")
            ? messages.EMAIL_REPEAT
            : messages.USERNAME_REPEAT,
        });
      }
      console.log(e);
      return res.status(400).json({ error: e });
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
    // Get the userId from the authentication middleware
    var playerId = req.playerId;

    // Get the new data from the body
    var name = req.body.name;
    var email = req.body.email;

    // If there is no data, return error
    if (!name && !email) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // This used to build the UPDATE by string concatenation against a `client`
    // that is never imported, so the route threw ReferenceError on every call.
    // Had it worked it would have been an injection: `check().escape()` escapes
    // HTML entities, not SQL quotes.
    const data = {};
    if (name) data.name = name;
    if (email) data.email = email.toLowerCase();

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
        select: { id: true, username: true, name: true, email: true },
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
  var playerId = req.playerId;

  // Get the new data from the body
  var password = req.body.password;
  var newPassword = req.body.newPassword;

  // If there is no data, return error
  if (!password || !newPassword) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
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
    data: { passwordhash: await _hash(newPassword, 8) },
  });

  return res.status(200).json({ message: messages.USER_UPDATED });
}));

// Return user's details based on the token
router.get("/me", asyncHandler(async (req, res) => {
  // Gets the userId from the authentication middleware
  var playerId = req.playerId;

  // Gets prisma from middleware
  const prisma = req.prisma;

  const player = await prisma.player.findUnique({ where: { id: playerId } });

  // If there are no results, return error
  if (!player) {
    return res.status(401).json({ message: messages.UNAUTHORIZED });
  }
  // If there is a user, return it
  delete player.passwordhash;
  delete player.id;
  return res.status(200).json(player);
}));

export default router;
