// Route file for locating a physical card in the shop.
//
// Mounted at /find behind the superuser middleware (see app.js).
//
// Answers "where is this card?" differently per container, because that is what
// actually helps someone walk over and pick it up:
//   binder       -> which binder, which page, which pocket, plus the whole page
//                   so it can be drawn
//   sorted_box   -> position in the box, plus the cards either side of it
//   unsorted_box -> just the box; there is nothing more specific to say
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import {
  spreadForPage,
  pagesInSpread,
  POCKETS_PER_PAGE,
} from "../services/storageContents.js";

const NEIGHBOURS = 3; // cards shown either side of a hit in a sorted box

const CARD_INCLUDE = {
  cardgeneral: true,
  cardcondition: { select: { name: true } },
  cardlanguage: { select: { name: true } },
  collection: { select: { id: true, player: { select: { name: true } } } },
};

function describe(placement) {
  const card = placement.card;
  return {
    placementid: placement.id,
    cardid: placement.cardid,
    copyindex: placement.copyindex,
    page: placement.page,
    pocket: placement.pocket,
    depth: placement.depth,
    sequence: placement.sequence,
    name: card?.cardgeneral?.name ?? null,
    cardsetcode: card?.cardgeneral?.cardsetcode ?? null,
    cardsetname: card?.cardgeneral?.cardsetname ?? null,
    image: card?.cardgeneral?.image ?? null,
    variant: card?.variant ?? null,
    condition: card?.cardcondition?.name ?? null,
    language: card?.cardlanguage?.name ?? null,
    owner: card?.collection?.player?.name ?? null,
  };
}

// Find every placed copy whose card name matches.
router.get(
  "/:cardName",
  [check("cardName").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const cardName = req.params.cardName;

    const placements = await prisma.cardplacement.findMany({
      where: {
        // A copy in a pick-up bag keeps its address so it can be refiled, but
        // it is not there now — sending someone to that pocket would waste
        // their time.
        orderlineid: null,
        card: {
          cardgeneral: { name: { contains: cardName, mode: "insensitive" } },
        },
      },
      include: {
        card: { include: CARD_INCLUDE },
        storage: { include: { player: { select: { name: true } } } },
      },
      orderBy: [{ storageid: "asc" }, { page: "asc" }, { pocket: "asc" }],
    });

    if (!placements.length) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    const results = [];
    for (const pl of placements) {
      const unit = pl.storage;
      const hit = {
        ...describe(pl),
        storage: {
          id: unit.id,
          name: unit.name,
          type: unit.type,
          state: unit.state,
          owner: unit.player?.name ?? null,
        },
      };

      if (unit.type === "binder") {
        hit.spread = spreadForPage(pl.page);
        // Ship the whole page so the UI can draw it with the hit highlighted.
        const onPage = await prisma.cardplacement.findMany({
          where: { storageid: unit.id, page: pl.page, orderlineid: null },
          include: { card: { include: CARD_INCLUDE } },
          orderBy: [{ pocket: "asc" }, { depth: "asc" }],
        });
        const byPocket = new Map();
        for (const other of onPage) {
          if (!byPocket.has(other.pocket)) byPocket.set(other.pocket, []);
          byPocket.get(other.pocket).push({
            ...describe(other),
            isMatch: other.id === pl.id,
          });
        }
        hit.pageContents = {
          page: pl.page,
          spreadPages: pagesInSpread(spreadForPage(pl.page)),
          pockets: Array.from({ length: POCKETS_PER_PAGE }, (_, i) => ({
            pocket: i + 1,
            cards: byPocket.get(i + 1) ?? [],
          })),
        };
      } else if (unit.type === "sorted_box") {
        const total = await prisma.cardplacement.count({
          where: { storageid: unit.id, orderlineid: null },
        });
        hit.positionInBox = pl.sequence;
        hit.boxSize = total;
        // A few cards either side, so it can be found by eye while flicking.
        const around = await prisma.cardplacement.findMany({
          where: {
            storageid: unit.id,
            orderlineid: null,
            sequence: {
              gte: Math.max(1, pl.sequence - NEIGHBOURS),
              lte: pl.sequence + NEIGHBOURS,
            },
          },
          include: { card: { include: CARD_INCLUDE } },
          orderBy: { sequence: "asc" },
        });
        hit.neighbours = around.map((other) => ({
          ...describe(other),
          isMatch: other.id === pl.id,
        }));
      }
      // unsorted_box: naming the box is all the precision there is.

      results.push(hit);
    }

    return res.status(200).json({
      query: cardName,
      matches: results.length,
      results,
    });
  })
);

export default router;
