// Route file for sales operations
import { Router } from "express";
var router = Router();
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";

// Get the user's sales
router.get(
  "/",
  asyncHandler(async (req, res) => {
    // Gets the playerId from the authentication middleware
    const playerId = req.playerId;

    // Gets prisma from middleware
    const prisma = req.prisma;

    const collection = await prisma.collection.findFirst({
      where: { playerid: playerId },
      orderBy: { id: "asc" },
    });

    // If there are no results, return error
    if (!collection) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }

    const sales = await prisma.sale.findMany({
      where: { collectionid: collection.id },
      include: {
        cardgeneral: true,
        cardcondition: { select: { name: true } },
        cardlanguage: { select: { name: true } },
      },
      orderBy: [{ date: "desc" }],
    });

    const { id, playerid, ...collectionToReturn } = collection;

    // Flatten the joined lookups into the shape the UI reads.
    collectionToReturn.sales = sales
      .map((sale) => {
        const { cardgeneral, cardcondition, cardlanguage, ...rest } = sale;
        return {
          ...rest,
          ...cardgeneral,
          condition: cardcondition?.name ?? null,
          language: cardlanguage?.name ?? null,
        };
      })
      // Prisma cannot order by a joined column, so the secondary sort by card
      // name happens here. Sales are already newest-first from the database.
      .sort(
        (a, b) => b.date - a.date || (a.name ?? "").localeCompare(b.name ?? "")
      );

    res.status(200).json(collectionToReturn);
  })
);

export default router;
