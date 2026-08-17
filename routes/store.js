// Route file for store
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";

const PAGE_SIZE = 50;
const SEARCH_PAGE_SIZE = 200;

// Shape a card row the way both UIs read it: card fields at the top level,
// with the cardgeneral join (name, image, set) flattened in alongside the
// condition and language names.
function flattenCard(card) {
  const { cardgeneral, cardcondition, cardlanguage, collection, ...rest } = card;
  return {
    ...rest,
    ...cardgeneral,
    cardname: cardgeneral?.name ?? null,
    condition: cardcondition?.name ?? null,
    language: cardlanguage?.name ?? null,
    collection: collection?.id ?? null,
    player: collection?.player?.name ?? null,
    percent: collection?.percent ?? null,
  };
}

const CARD_INCLUDE = {
  cardgeneral: true,
  cardcondition: { select: { name: true } },
  cardlanguage: { select: { name: true } },
  collection: { select: { id: true, percent: true, player: { select: { name: true } } } },
};

// Return all available cards in the store paginated
router.get(
  "/:page",
  [check("page").isNumeric()],
  asyncHandler(async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const page = Math.max(1, parseInt(req.params.page, 10) || 1);

    // Gets prisma from middleware
    const prisma = req.prisma;

    const where = { collection: { active: true } };

    // Count and page in the database rather than loading every card and
    // slicing in JS, which is what this route used to do.
    const [numberOfCards, cards] = await Promise.all([
      prisma.card.count({ where }),
      prisma.card.findMany({
        where,
        include: CARD_INCLUDE,
        orderBy: { id: "asc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);

    return res.status(200).json({
      numberOfCards,
      numberOfPages: Math.ceil(numberOfCards / PAGE_SIZE),
      cards: cards.map(flattenCard),
    });
  })
);

// Returns a specific card from the store
router.get(
  "/search/:cardName",
  [check("cardName").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    // Validates that the parameters are correct
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // If one of them isn't, returns an error
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const cardName = req.params.cardName;

    // Parameterised by Prisma — this used to interpolate cardName straight
    // into a LIKE clause.
    const where = {
      collection: { active: true },
      cardgeneral: { name: { contains: cardName, mode: "insensitive" } },
    };

    const cards = await req.prisma.card.findMany({
      where,
      include: CARD_INCLUDE,
      take: SEARCH_PAGE_SIZE,
    });

    // If no cards match the search, return not found
    if (!cards.length) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    const flattened = cards
      .map(flattenCard)
      .sort((a, b) => (a.cardname ?? "").localeCompare(b.cardname ?? ""));

    return res.status(200).json({
      numberOfCards: flattened.length,
      numberOfPages: Math.ceil(flattened.length / SEARCH_PAGE_SIZE),
      cards: flattened,
    });
  })
);

export default router;
