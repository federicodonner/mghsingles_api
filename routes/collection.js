// Route file for operations to the user's collection
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";

// Get the user's collection
router.get(
  "/",
  asyncHandler(async (req, res) => {
    // Gets the userId from the authentication middleware
    const playerid = req.playerId;

    // Gets prisma from middleware
    const prisma = req.prisma;

    // Gets the card collection
    const collections = await prisma.collection.findMany({
      where: { playerid },
      include: {
        card: {
          include: {
            cardgeneral: true,
            cardcondition: { select: { name: true } },
            cardlanguage: { select: { name: true } },
          },
        },
      },
    });

    // If there are no results, return error
    if (!collections.length) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }

    // The UI reads `condition` and `language` as flat strings on each card.
    return res.status(200).json(
      collections.map((collection) => ({
        ...collection,
        card: collection.card.map(({ cardcondition, cardlanguage, ...card }) => ({
          ...card,
          condition: cardcondition?.name ?? null,
          language: cardlanguage?.name ?? null,
        })),
      }))
    );
  })
);

// Get all collections
// Declared before "/:collectionId" so that "all" is not swallowed by the
// numeric-id route.
router.get(
  "/all",
  asyncHandler(async (req, res) => {
    // Gets prisma from middleware
    const prisma = req.prisma;

    const collections = await prisma.collection.findMany({
      select: { id: true, player: { select: { name: true } } },
      orderBy: { player: { name: "asc" } },
    });

    // If there are no results, return error
    if (!collections.length) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }

    res
      .status(200)
      .json(collections.map((c) => ({ id: c.id, name: c.player?.name ?? null })));
  })
);

// Get a specific collection
router.get(
  "/:collectionId",
  [check("collectionId").isNumeric()],
  asyncHandler(async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    // Gets the userId from the authentication middleware
    const playerId = req.playerId;
    const collectionId = parseInt(req.params.collectionId, 10);

    // Gets prisma from middleware
    const prisma = req.prisma;

    // Scoped to the requesting player: this route used to interpolate both
    // ids straight into SQL.
    const collection = await prisma.collection.findFirst({
      where: { id: collectionId, playerid: playerId },
    });

    // If there are no results, return error
    if (!collection) {
      return res.status(404).json({ message: messages.COLLECTION_PROBLEM });
    }

    const cards = await prisma.card.findMany({
      where: { collectionid: collection.id },
      include: {
        cardgeneral: true,
        cardcondition: { select: { name: true } },
        cardlanguage: { select: { name: true } },
        cardposition: true,
      },
    });

    const { playerid, ...collectionToReturn } = collection;

    collectionToReturn.cards = cards
      .map((card) => {
        const {
          cardgeneral,
          cardcondition,
          cardlanguage,
          cardposition,
          ...rest
        } = card;
        // A card has at most one position row in practice; the schema allows
        // many, so take the first deterministically.
        const position = cardposition.sort((a, b) => a.id - b.id)[0] ?? null;
        return {
          id: rest.id,
          quantity: rest.quantity,
          variant: rest.variant,
          name: cardgeneral?.name ?? null,
          cardset: cardgeneral?.cardsetcode ?? null,
          cardsetname: cardgeneral?.cardsetname ?? null,
          image: cardgeneral?.image ?? null,
          condition: cardcondition?.name ?? null,
          language: cardlanguage?.name ?? null,
          positionid: position?.id ?? null,
          copyindex: position?.copyindex ?? null,
          depth: position?.depth ?? null,
          page: position?.page ?? null,
          position: position?.position ?? null,
        };
      })
      .sort(
        (a, b) => (a.page ?? 0) - (b.page ?? 0) || (a.position ?? 0) - (b.position ?? 0)
      );

    // Determine the number of pages for the sorter
    if (collectionToReturn.binder) {
      const maxPage = await prisma.cardposition.aggregate({
        where: { collectionid: collection.id },
        _max: { page: true },
      });
      collectionToReturn.maxPage = maxPage._max.page;
    }

    res.status(200).json(collectionToReturn);
  })
);

export default router;
