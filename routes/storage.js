// Route file for physical storage: binders, sorted boxes and unsorted boxes.
//
// Mounted at /storage behind the staff middleware (see app.js). This is the
// shop's view: every container, whoever owns it.
//
// A storage unit belongs to the shop (playerid null) or to a customer. Only a
// unit in the `for_sale` state has its cards on sale; see
// services/storageState.js for the lifecycle and who may move it along. The
// customer's half of that lifecycle lives in routes/mystorage.js, and the
// mechanics both sides share live in services/storageContents.js.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler from "../middleware/asyncHandler.js";
import {
  STATES,
  shopCanMove,
  committedPlacements,
} from "../services/storageState.js";
import {
  POCKETS_PER_PAGE,
  spreadForPage,
  pagesInSpread,
  ContentsError,
  describeUnit,
  readContents,
  placeCopy,
  removePlacement,
  movePlacement,
} from "../services/storageContents.js";

const TYPES = ["binder", "sorted_box", "unsorted_box"];

const STATE_MESSAGE = {
  for_sale: messages.STORAGE_FOR_SALE,
  retired: messages.STORAGE_RETIRED,
  released: messages.STORAGE_RELEASED,
  returning: messages.STORAGE_RETURNING,
};

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
      // Copies in a pick-up bag are not physically in the container, so they
      // must not be counted as being in it — the contents view already excludes
      // them, and a count that disagreed would look like lost cards.
      _count: { select: { cardplacement: { where: { orderlineid: null } } } },
      },
      orderBy: [{ playerid: "asc" }, { name: "asc" }],
    });

    return res.status(200).json(
      units.map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        state: u.state,
        forsale: u.state === "for_sale",
        owner: u.player ? { id: u.player.id, name: u.player.name } : null,
        cardcount: u._count.cardplacement,
        // What the shop may do with it next, so the UI does not reimplement the
        // state machine to decide which buttons to draw. A shop-owned container
        // has nobody to hand it to, so it never moves.
        cando: u.playerid === null
          ? []
          : STATES.filter((to) => shopCanMove(u.state, to)),
        // Whether the shop physically holds it, and so may rename, delete or
        // rearrange it at all.
        inshop: u.state !== "released",
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
        // Created by the shop, so it is on the shelf and for sale. A customer
        // creating their own container does it from /mystorage, and that one
        // starts released — it is in their hands, not the shop's.
        state: "for_sale",
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
    // A released container is the customer's to name; the shop does not hold it.
    if (unit.state === "released") {
      return res.status(400).json({ message: messages.STORAGE_WITH_CUSTOMER });
    }

    const data = {};
    if (typeof req.body.name === "string" && req.body.name.trim()) {
      data.name = req.body.name.trim();
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
    if (unit.state === "released") {
      return res.status(400).json({ message: messages.STORAGE_WITH_CUSTOMER });
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
// Lifecycle — the shop's half
// --------------------------------------------------------------------------

// Move a customer's container along its lifecycle.
//
// Body: { state } — one of released, for_sale (see services/storageState.js
// for which moves the shop is allowed to make and why).
//
// The interesting one is retired -> released: copies already promised to a
// buyer are sitting in a bag on the counter, not in the container, so they do
// not go home with it. Their placement rows are KEPT — that address is the only
// record of where the card came from — and the container's state is what tells
// a later refile that the binder has left the building. They are reported here
// so whoever hands the binder over knows which cards to hold back.
router.post(
  "/:storageId/state",
  [check("storageId").isNumeric(), check("state").isIn(STATES)],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const id = parseInt(req.params.storageId, 10);
    const target = req.body.state;

    const unit = await prisma.storage.findUnique({
      where: { id },
      include: { player: { select: { id: true, name: true } } },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }
    // The shop's own containers have no owner to hand them to, so they never
    // leave for_sale.
    if (unit.playerid === null) {
      return res.status(400).json({ message: messages.STORAGE_SHOP_OWNED });
    }
    if (!shopCanMove(unit.state, target)) {
      return res.status(400).json({
        message: messages.STORAGE_BAD_STATE,
        state: unit.state,
      });
    }

    const committed =
      target === "released" ? await committedPlacements(prisma, id) : [];

    const updated = await prisma.storage.update({
      where: { id },
      data: { state: target },
    });

    return res.status(200).json({
      message: STATE_MESSAGE[target],
      id: updated.id,
      name: updated.name,
      state: updated.state,
      forsale: updated.state === "for_sale",
      owner: unit.player ? { id: unit.player.id, name: unit.player.name } : null,
      // Cards that stay behind on the counter rather than going home.
      heldback: committed.map((pl) => ({
        placementid: pl.id,
        cardid: pl.cardid,
        copyindex: pl.copyindex,
        name: pl.card?.cardgeneral?.name ?? null,
        page: pl.page,
        pocket: pl.pocket,
        sequence: pl.sequence,
        buyerid: pl.orderline?.order?.playerid ?? null,
      })),
    });
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
    const id = parseInt(req.params.storageId, 10);

    const unit = await req.prisma.storage.findUnique({
      where: { id },
      include: { player: { select: { id: true, name: true } } },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }

    const spread =
      req.query.spread === undefined
        ? null
        : Math.max(0, parseInt(req.query.spread, 10) || 0);

    return res.status(200).json(await readContents(req.prisma, unit, { spread }));
  })
);

// --------------------------------------------------------------------------
// Placing and removing copies
// --------------------------------------------------------------------------

// A released container is in the customer's living room. The shop cannot
// rearrange it, and recording a move into it would claim a card is somewhere
// nobody behind the counter can reach.
function shopMayTouch(unit) {
  return unit.state !== "released";
}

// Place one copy of a card into a unit.
// Body: { cardid, copyindex, page, pocket, sequence }
router.post(
  "/:storageId/place",
  [check("storageId").isNumeric(), check("cardid").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const unit = await req.prisma.storage.findUnique({
      where: { id: parseInt(req.params.storageId, 10) },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }
    if (!shopMayTouch(unit)) {
      return res.status(400).json({ message: messages.STORAGE_WITH_CUSTOMER });
    }

    try {
      const { placement } = await placeCopy(req.prisma, unit, req.body);
      return res.status(201).json(placement);
    } catch (err) {
      if (err instanceof ContentsError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }
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
    const placement = await req.prisma.cardplacement.findUnique({
      where: { id: parseInt(req.params.placementId, 10) },
      include: { storage: true },
    });
    if (!placement) {
      return res.status(404).json({ message: messages.PLACEMENT_NOT_FOUND });
    }
    if (!shopMayTouch(placement.storage)) {
      return res.status(400).json({ message: messages.STORAGE_WITH_CUSTOMER });
    }
    // Dropping the row would erase the only record of where a bagged card goes
    // back to if the order falls through.
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    await removePlacement(req.prisma, placement);
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

    const [placement, unit] = await Promise.all([
      prisma.cardplacement.findUnique({
        where: { id: parseInt(req.params.placementId, 10) },
        include: { storage: true },
      }),
      prisma.storage.findUnique({
        where: { id: parseInt(req.body.storageid, 10) },
      }),
    ]);
    if (!placement) {
      return res.status(404).json({ message: messages.PLACEMENT_NOT_FOUND });
    }
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }
    // Neither end of the move may be a container the shop no longer holds.
    if (!shopMayTouch(placement.storage) || !shopMayTouch(unit)) {
      return res.status(400).json({ message: messages.STORAGE_WITH_CUSTOMER });
    }
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    try {
      return res
        .status(200)
        .json(await movePlacement(prisma, placement, unit, req.body));
    } catch (err) {
      if (err instanceof ContentsError) {
        return res.status(err.status).json({ message: err.message });
      }
      throw err;
    }
  })
);

export default router;
export { POCKETS_PER_PAGE, spreadForPage, pagesInSpread };
