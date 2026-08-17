import { Router } from "express";
var router = Router();
import asyncHandler from "../middleware/asyncHandler.js";

// Add cards to cardgeneral
router.post("/", asyncHandler(async (req, res) => {
  // Gets prisma from middleware
  const prisma = req.prisma;

  // Determines if posting sets or cards
  if (req.body.sets) {
    // Get sets
    const setsToAdd = req.body.setsToAdd;

    try {
      // Check if the user wants to clear the database
      if (req.body.deleteDatabase) {
        await prisma.cardset.deleteMany({});
      }

      for (const setToAdd of setsToAdd) {
        await prisma.cardset.upsert({
          where: { cardset: setToAdd.cardset },
          update: {
            cardsetname: setToAdd.cardsetname,
            releasedate: new Date(setToAdd.releasedate),
            iconsvguri: setToAdd.iconsvguri,
          },
          create: {
            cardsetname: setToAdd.cardsetname,
            releasedate: new Date(setToAdd.releasedate),
            iconsvguri: setToAdd.iconsvguri,
            cardset: setToAdd.cardset,
          },
        });
      }

      return res.status(200).json({ message: "ok" });
    } catch (e) {
      console.log(e);
      return res.status(400).json(e);
    }
  } else {
    // Get cards
    const cardsToAdd = req.body.cardsToAdd;
    // Check if the user wants to clear the database
    // should be set on the first call of the database update

    try {
      if (req.body.deleteDatabase) {
        await prisma.cardgeneral.deleteMany({});
      }

      for (const cardToAdd of cardsToAdd) {
        await prisma.cardgeneral.create({
          data: {
            scryfallid: cardToAdd.scryfallid,
            name: cardToAdd.name,
            cardsetcode: cardToAdd.cardsetcode,
            cardsetname: cardToAdd.cardsetname,
            image: cardToAdd.image,
            releasedatyear: parseInt(cardToAdd.releasedatyear),
            borderless: cardToAdd.borderless,
            showcase: cardToAdd.showcase,
            phyrexian: cardToAdd.phyrexian,
            extendedart: cardToAdd.extendedart,
            retroframe: cardToAdd.retroframe,
            boxtopper: cardToAdd.boxtopper,
            color: cardToAdd.color,
            rarity: cardToAdd.rarity,
            collectornumber: cardToAdd.collectornumber,
          },
        });
      }

      return res.status(200).json({ message: "ok" });
    } catch (e) {
      console.log(e);
      return res.status(400).json(e);
    }
  }
}));

export default router;
