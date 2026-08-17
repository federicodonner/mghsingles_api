// Route file for getting and editing gastos
import { Router } from "express";
var router = Router();
import { compare } from "bcrypt";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import { generateToken } from "../utils/utils.js";

// Validate the user and return the token
router.post("/", asyncHandler(async (req, res) => {
  // Loads the data into variables to use
  var username = req.body.username;
  var password = req.body.password;

  // Validates that all the compulsory fields are present
  if (!username || !password) {
    return res.status(400).json({ message: messages.PARAMETERS_ERROR });
  }

  // Gets prisma from the middleware
  const prisma = req.prisma;

  const player = await prisma.player.findFirst({ where: { username } });

  // Verifies that the user exists
  if (!player) {
    return res.status(404).json({ message: messages.USER_NOT_FOUND });
  }

  // The UI needs to know what this account may do, so it can send a customer
  // to the store and a shop hand to the back office.
  let role = player.role;

  // Verifies that the password is correct
  const passwordResult = await compare(password, player.passwordhash);
  if (!passwordResult) {
    return res.status(401).json({ message: messages.INCORRECT_PASSWORD });
  }

  // Generate the login record with the token
  var token = generateToken(25);
  const newToken = await prisma.login.create({
    data: { date: new Date(), playerid: player.id, token },
  });
  return res.status(200).json({ token: newToken.token, role });
}));

export default router;
