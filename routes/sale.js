// Route file for sales operations
import { Router } from "express";
var router = Router();
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import { saleNet, saleRemaining, ZERO } from "../services/credit.js";

// Get the user's sales
router.get(
  "/",
  asyncHandler(async (req, res) => {
    // Gets the playerId from the authentication middleware
    const playerId = requirePlayerId(req);

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

    // What the store still owes across all sales — also the credit this
    // customer can spend on a purchase at the counter.
    let pending = ZERO;

    // Flatten the joined lookups into the shape the UI reads, and settle the
    // money questions server-side so every surface shows the same cents.
    collectionToReturn.sales = sales
      .map((sale) => {
        const { cardgeneral, cardcondition, cardlanguage, ...rest } = sale;
        const remaining = saleRemaining(sale);
        pending = pending.add(remaining);
        return {
          ...rest,
          ...cardgeneral,
          condition: cardcondition?.name ?? null,
          language: cardlanguage?.name ?? null,
          net: saleNet(sale).toFixed(2),
          remaining: remaining.toFixed(2),
          paid: remaining.lte(0),
        };
      })
      // Prisma cannot order by a joined column, so the secondary sort by card
      // name happens here. Sales are already newest-first from the database.
      .sort(
        (a, b) => b.date - a.date || (a.name ?? "").localeCompare(b.name ?? "")
      );

    collectionToReturn.pending = pending.toFixed(2);

    res.status(200).json(collectionToReturn);
  })
);

export default router;
