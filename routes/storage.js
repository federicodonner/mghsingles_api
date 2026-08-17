// Route file for physical storage: binders, sorted boxes and unsorted boxes.
//
// Mounted at /storage behind the superuser middleware (see app.js).
//
// A storage unit belongs to the shop (playerid null) or to a customer. A
// customer's unit can be left in the shop to sell from (`inshop` true) or taken
// home (`inshop` false); cards in a unit that is not in the shop are out of the
// sellable inventory.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";

const TYPES = ["binder", "sorted_box", "unsorted_box"];
const POCKETS_PER_PAGE = 9; // 3x3

// Binder spreads show one page beside another, but page 1 has nothing facing
// it — like opening a real binder. So spread 0 is [null, 1], spread 1 is
// [2, 3], spread 2 is [4, 5], and so on.
export function spreadForPage(page) {
  return page <= 1 ? 0 : Math.floor(page / 2);
}
export function pagesInSpread(spread) {
  if (spread <= 0) return [null, 1];
  return [spread * 2, spread * 2 + 1];
}

const CARD_INCLUDE = {
  card: {
    include: {
      cardgeneral: true,
      cardcondition: { select: { name: true } },
      cardlanguage: { select: { name: true } },
      collection: {
        select: { id: true, player: { select: { id: true, name: true } } },
      },
    },
  },
};

// Flatten a placement + its card into what the UI renders.
function describePlacement(placement) {
  const { card, ...pl } = placement;
  return {
    placementid: pl.id,
    cardid: pl.cardid,
    copyindex: pl.copyindex,
    page: pl.page,
    pocket: pl.pocket,
    depth: pl.depth,
    sequence: pl.sequence,
    name: card?.cardgeneral?.name ?? null,
    cardsetcode: card?.cardgeneral?.cardsetcode ?? null,
    cardsetname: card?.cardgeneral?.cardsetname ?? null,
    image: card?.cardgeneral?.image ?? null,
    variant: card?.variant ?? null,
    condition: card?.cardcondition?.name ?? null,
    language: card?.cardlanguage?.name ?? null,
    owner: card?.collection?.player?.name ?? null,
    collectionid: card?.collection?.id ?? null,
  };
}

// --------------------------------------------------------------------------
// Storage CRUD
// --------------------------------------------------------------------------

// List every storage unit with a count of what is in it.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    const units = await prisma.storage.findMany({
      include: {
        player: { select: { id: true, name: true } },
        _count: { select: { cardplacement: true } },
      },
      orderBy: [{ playerid: "asc" }, { name: "asc" }],
    });

    return res.status(200).json(
      units.map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        inshop: u.inshop,
        owner: u.player ? { id: u.player.id, name: u.player.name } : null,
        cardcount: u._count.cardplacement,
      }))
    );
  })
);

// Create a storage unit.
router.post(
  "/",
  [check("name").trim().notEmpty(), check("type").isIn(TYPES)],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;

    const playerid =
      req.body.playerid === undefined || req.body.playerid === null
        ? null
        : parseInt(req.body.playerid, 10);

    if (playerid !== null) {
      const player = await prisma.player.findUnique({ where: { id: playerid } });
      if (!player) {
        return res.status(404).json({ message: messages.USER_NOT_FOUND });
      }
    }

    const unit = await prisma.storage.create({
      data: {
        name: String(req.body.name).trim(),
        type: req.body.type,
        playerid,
        // A shop-owned unit is always in the shop.
        inshop: playerid === null ? true : req.body.inshop !== false,
      },
    });

    return res.status(201).json(unit);
  })
);

// Rename a unit, or toggle whether the customer has taken it home.
router.put(
  "/:storageId",
  [check("storageId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.storageId, 10);

    const unit = await prisma.storage.findUnique({ where: { id } });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }

    const data = {};
    if (typeof req.body.name === "string" && req.body.name.trim()) {
      data.name = req.body.name.trim();
    }
    if (typeof req.body.inshop === "boolean") {
      // The shop cannot hand its own binder to a customer.
      if (unit.playerid === null && req.body.inshop === false) {
        return res.status(400).json({ message: messages.STORAGE_SHOP_OWNED });
      }
      data.inshop = req.body.inshop;
    }
    if (!Object.keys(data).length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    const updated = await prisma.storage.update({ where: { id }, data });
    return res.status(200).json(updated);
  })
);

// Delete a unit. Refuses while it still holds cards, so nothing loses its
// location by accident — empty it first.
router.delete(
  "/:storageId",
  [check("storageId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.storageId, 10);

    const unit = await prisma.storage.findUnique({
      where: { id },
      include: { _count: { select: { cardplacement: true } } },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }
    if (unit._count.cardplacement > 0) {
      return res.status(400).json({
        message: messages.STORAGE_NOT_EMPTY,
        cardcount: unit._count.cardplacement,
      });
    }

    await prisma.storage.delete({ where: { id } });
    return res.status(200).json({ message: messages.STORAGE_DELETED });
  })
);

// --------------------------------------------------------------------------
// Reading a unit's contents
// --------------------------------------------------------------------------

// Contents of one unit. For a binder, `?spread=N` returns just that spread;
// otherwise the whole unit comes back.
router.get(
  "/:storageId",
  [check("storageId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.storageId, 10);

    const unit = await prisma.storage.findUnique({
      where: { id },
      include: { player: { select: { id: true, name: true } } },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }

    const base = {
      id: unit.id,
      name: unit.name,
      type: unit.type,
      inshop: unit.inshop,
      owner: unit.player ? { id: unit.player.id, name: unit.player.name } : null,
    };

    if (unit.type === "binder") {
      const maxPage = await prisma.cardplacement.aggregate({
        where: { storageid: id, orderlineid: null },
        _max: { page: true },
      });
      base.maxPage = maxPage._max.page ?? 1;
      base.maxSpread = spreadForPage(base.maxPage);

      const spread =
        req.query.spread === undefined
          ? null
          : Math.max(0, parseInt(req.query.spread, 10) || 0);

      // A copy sitting in someone's pick-up bag is not physically in the
      // binder, even though its address is retained so it can be refiled.
      const where = { storageid: id, orderlineid: null };
      if (spread !== null) {
        base.spread = spread;
        where.page = { in: pagesInSpread(spread).filter((p) => p !== null) };
      }

      const placements = await prisma.cardplacement.findMany({
        where,
        include: CARD_INCLUDE,
        orderBy: [{ page: "asc" }, { pocket: "asc" }, { depth: "asc" }],
      });

      // Group into pages, then pockets, so the UI renders a 3x3 grid of stacks
      // without regrouping anything itself.
      const byPage = new Map();
      for (const pl of placements) {
        if (!byPage.has(pl.page)) byPage.set(pl.page, new Map());
        const pockets = byPage.get(pl.page);
        if (!pockets.has(pl.pocket)) pockets.set(pl.pocket, []);
        pockets.get(pl.pocket).push(describePlacement(pl));
      }

      const renderPage = (page) =>
        page === null
          ? null
          : {
              page,
              pockets: Array.from({ length: POCKETS_PER_PAGE }, (_, i) => ({
                pocket: i + 1,
                cards: byPage.get(page)?.get(i + 1) ?? [],
              })),
            };

      base.pages =
        spread !== null
          ? pagesInSpread(spread).map(renderPage)
          : [...byPage.keys()].sort((a, b) => a - b).map(renderPage);

      return res.status(200).json(base);
    }

    // Boxes: a flat list. Sorted boxes carry a sequence, unsorted ones do not.
    const placements = await prisma.cardplacement.findMany({
      where: { storageid: id, orderlineid: null },
      include: CARD_INCLUDE,
      orderBy:
        unit.type === "sorted_box" ? { sequence: "asc" } : { id: "asc" },
    });
    base.cards = placements.map(describePlacement);
    base.cardcount = placements.length;

    return res.status(200).json(base);
  })
);

// --------------------------------------------------------------------------
// Placing and removing copies
// --------------------------------------------------------------------------

// Place one copy of a card into a unit.
//
// Body: { cardid, copyindex, page, pocket, sequence }
// - binder: page and pocket required; depth is assigned (back of the stack)
// - sorted_box: sequence optional, appended to the end when omitted
// - unsorted_box: no coordinates
router.post(
  "/:storageId/place",
  [check("storageId").isNumeric(), check("cardid").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const storageid = parseInt(req.params.storageId, 10);
    const cardid = parseInt(req.body.cardid, 10);

    const [unit, card] = await Promise.all([
      prisma.storage.findUnique({ where: { id: storageid } }),
      prisma.card.findUnique({
        where: { id: cardid },
        include: { cardplacement: true },
      }),
    ]);
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }
    if (!card) {
      return res.status(404).json({ message: messages.CARD_NOT_FOUND });
    }

    // Validate the coordinates before allocating a copy, so a bad pocket
    // reports a bad pocket rather than whatever the copy allocator hits first.
    let page = null;
    let pocket = null;
    if (unit.type === "binder") {
      page = parseInt(req.body.page, 10);
      pocket = parseInt(req.body.pocket, 10);
      if (!(page >= 1) || !(pocket >= 1 && pocket <= POCKETS_PER_PAGE)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
    } else if (unit.type === "sorted_box" && req.body.sequence !== undefined) {
      if (!(parseInt(req.body.sequence, 10) >= 1)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
    }

    // Pick the copy to place: the caller may name one, otherwise take the
    // lowest index that is not already somewhere.
    const taken = new Set(card.cardplacement.map((pl) => pl.copyindex));
    let copyindex;
    if (req.body.copyindex !== undefined) {
      copyindex = parseInt(req.body.copyindex, 10);
      if (!(copyindex >= 1 && copyindex <= card.quantity)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
      if (taken.has(copyindex)) {
        return res.status(400).json({ message: messages.COPY_ALREADY_PLACED });
      }
    } else {
      copyindex = null;
      for (let i = 1; i <= card.quantity; i++) {
        if (!taken.has(i)) {
          copyindex = i;
          break;
        }
      }
      if (copyindex === null) {
        return res.status(400).json({ message: messages.ALL_COPIES_PLACED });
      }
    }

    const data = { cardid, copyindex, storageid };

    if (unit.type === "binder") {
      // Pockets hold several cards; the new one goes behind whatever is there.
      const deepest = await prisma.cardplacement.aggregate({
        where: { storageid, page, pocket },
        _max: { depth: true },
      });
      data.page = page;
      data.pocket = pocket;
      data.depth = (deepest._max.depth ?? 0) + 1;
    } else if (unit.type === "sorted_box") {
      if (req.body.sequence !== undefined) {
        data.sequence = parseInt(req.body.sequence, 10);
        // Make room by shifting everything at or after this position back.
        await prisma.cardplacement.updateMany({
          where: { storageid, sequence: { gte: data.sequence } },
          data: { sequence: { increment: 1 } },
        });
      } else {
        const last = await prisma.cardplacement.aggregate({
          where: { storageid },
          _max: { sequence: true },
        });
        data.sequence = (last._max.sequence ?? 0) + 1;
      }
    }

    const placement = await prisma.cardplacement.create({ data });
    return res.status(201).json(placement);
  })
);

// Remove a copy from wherever it is.
router.delete(
  "/placement/:placementId",
  [check("placementId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.placementId, 10);

    const placement = await prisma.cardplacement.findUnique({
      where: { id },
      include: { storage: true },
    });
    if (!placement) {
      return res.status(404).json({ message: messages.PLACEMENT_NOT_FOUND });
    }

    await prisma.$transaction(async (tx) => {
      await tx.cardplacement.delete({ where: { id } });

      // Close the gap left behind so positions stay contiguous.
      if (placement.storage.type === "binder") {
        await tx.cardplacement.updateMany({
          where: {
            storageid: placement.storageid,
            page: placement.page,
            pocket: placement.pocket,
            depth: { gt: placement.depth },
          },
          data: { depth: { decrement: 1 } },
        });
      } else if (placement.storage.type === "sorted_box") {
        await tx.cardplacement.updateMany({
          where: {
            storageid: placement.storageid,
            sequence: { gt: placement.sequence },
          },
          data: { sequence: { decrement: 1 } },
        });
      }
    });

    return res.status(200).json({ message: messages.PLACEMENT_REMOVED });
  })
);

// Move an existing placement to a new spot (same unit or another).
router.put(
  "/placement/:placementId",
  [check("placementId").isNumeric(), check("storageid").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.placementId, 10);
    const storageid = parseInt(req.body.storageid, 10);

    const [placement, unit] = await Promise.all([
      prisma.cardplacement.findUnique({ where: { id } }),
      prisma.storage.findUnique({ where: { id: storageid } }),
    ]);
    if (!placement) {
      return res.status(404).json({ message: messages.PLACEMENT_NOT_FOUND });
    }
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }

    const data = { storageid, page: null, pocket: null, depth: null, sequence: null };

    if (unit.type === "binder") {
      const page = parseInt(req.body.page, 10);
      const pocket = parseInt(req.body.pocket, 10);
      if (!(page >= 1) || !(pocket >= 1 && pocket <= POCKETS_PER_PAGE)) {
        return res.status(400).json({ message: messages.PARAMETERS_ERROR });
      }
      const deepest = await prisma.cardplacement.aggregate({
        where: { storageid, page, pocket, NOT: { id } },
        _max: { depth: true },
      });
      data.page = page;
      data.pocket = pocket;
      data.depth = (deepest._max.depth ?? 0) + 1;
    } else if (unit.type === "sorted_box") {
      const last = await prisma.cardplacement.aggregate({
        where: { storageid, NOT: { id } },
        _max: { sequence: true },
      });
      data.sequence =
        req.body.sequence !== undefined
          ? parseInt(req.body.sequence, 10)
          : (last._max.sequence ?? 0) + 1;
    }

    const updated = await prisma.cardplacement.update({ where: { id }, data });
    return res.status(200).json(updated);
  })
);

export default router;
export { POCKETS_PER_PAGE };
