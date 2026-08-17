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
    var username = req.body.username;
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
      // Verifies that the username is not already in use
      const existingUser = await prisma.player.findFirst({ where: { email } });

      if (existingUser) {
        return res.status(400).json({ message: messages.USERNAME_REPEAT });
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
    let sql = "UPDATE player SET ";

    if (name) {
      sql = sql + "name='" + name + "'";
    }

    if (name && email) {
      sql = sql + ", ";
    }

    if (email) {
      sql = sql + "email='" + email + "'";
    }

    sql = sql + " WHERE id = " + playerId;
    sql = sql + " RETURNING username, name, email, id";
    let result = await client.query(sql);
    if (result.err) {
      throw result.err;
    }

    return res.status(200).json(result.rows[0]);
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

  // Verify that the old password is correct
  let sql = "SELECT * FROM player WHERE id = " + playerId;
  let players = await client.query(sql);
  if (players.err) {
    throw players.err;
  }
  // Verifies that the password is correct
  hashedPassword = players.rows[0].passwordhash;
  let passwordResult = await compare(password, hashedPassword);
  if (!passwordResult) {
    return res.status(400).json({ message: messages.INCORRECT_PASSWORD });
  }

  // If the password is correct, create the hash and store it
  // Hash the password
  let hash = await _hash(newPassword, 8);
  sql = "UPDATE player SET passwordHash='" + hash + "' WHERE id = " + playerId;
  let result = await client.query(sql);
  if (result.err) {
    throw result.err;
  }
  return res.status(200).json({ message: messages.USER_UPDATED });
}));

// Return user's details based on the token
router.get("/me", asyncHandler(async (req, res) => {
  // Gets the userId from the authentication middleware
  var playerId = req.playerId;
  console.log(playerId);

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
