// A customer's own binders and boxes.
//
// Mounted at /mystorage behind `authentication` (see app.js). Every query here
// is scoped by playerid, so a customer sees and touches only their own
// containers — the shop's view of the same objects is routes/storage.js.
//
// The lifecycle is in services/storageState.js. The customer's half of it:
//
//   create           -> released   they made a new binder at home
//   for_sale -> retired            "I want my binder back" — cards come off
//                                  sale immediately, before it physically moves
//   released -> returning          "I am bringing it in"
//
// The shop performs the other half, because those steps are assertions about
// what physically happened at the counter.
import { Router } from "express";
var router = Router();
import { check, validationResult } from "express-validator";
import messages from "../data/messages.js";
import asyncHandler, { requirePlayerId } from "../middleware/asyncHandler.js";
import { STATES, customerCanMove, customerCanEdit } from "../services/storageState.js";
import {
  ContentsError,
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

// Load a container and prove it belongs to the caller.
//
// `playerid: playerId` is an equality filter on a value that is never
// undefined — requirePlayerId throws rather than returning one — so this cannot
// silently degrade into "any container with this id".
async function ownUnit(prisma, playerId, id) {
  const unit = await prisma.storage.findFirst({
    where: { id, playerid: playerId },
    include: { player: { select: { id: true, name: true } } },
  });
  if (!unit) throw new ContentsError(messages.STORAGE_NOT_FOUND, 404);
  return unit;
}

// A customer may rearrange a container only while it is in their hands.
function assertEditable(unit) {
  if (!customerCanEdit(unit.state)) {
    throw new ContentsError(messages.STORAGE_NOT_EDITABLE);
  }
}

// Turn the errors the helpers throw into responses.
function handle(err, res) {
  if (err instanceof ContentsError) {
    return res.status(err.status).json({ message: err.message });
  }
  throw err;
}

// --------------------------------------------------------------------------
// The customer's containers
// --------------------------------------------------------------------------

// Every container this customer owns, wherever it is in its lifecycle.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const playerId = requirePlayerId(req);

    const units = await req.prisma.storage.findMany({
      where: { playerid: playerId },
      include: {
        // Copies in a pick-up bag are not physically in the container, so they
        // must not be counted as being in it — the contents view already
        // excludes them, and a count that disagreed would look like lost cards.
        _count: { select: { cardplacement: { where: { orderlineid: null } } } },
      },
      orderBy: [{ name: "asc" }],
    });

    return res.status(200).json(
      units.map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        state: u.state,
        forsale: u.state === "for_sale",
        cardcount: u._count.cardplacement,
        editable: customerCanEdit(u.state),
        // What the customer may do with it next, so the UI does not have to
        // reimplement the state machine to decide which buttons to draw.
        cando: STATES.filter((to) => customerCanMove(u.state, to)),
      }))
    );
  })
);

// Create a container.
//
// It starts released: the customer has just made it, it is in their hands, and
// nothing in it is for sale until they bring it in and the shop accepts it.
router.post(
  "/",
  [check("name").trim().notEmpty(), check("type").isIn(TYPES)],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);

    const unit = await req.prisma.storage.create({
      data: {
        name: String(req.body.name).trim(),
        type: req.body.type,
        playerid: playerId,
        state: "released",
      },
    });

    return res.status(201).json({ ...unit, editable: true });
  })
);

// Contents of one of the customer's containers. `?spread=N` for binders.
router.get(
  "/:storageId",
  [check("storageId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);

    try {
      const unit = await ownUnit(
        req.prisma,
        playerId,
        parseInt(req.params.storageId, 10)
      );
      const spread =
        req.query.spread === undefined
          ? null
          : Math.max(0, parseInt(req.query.spread, 10) || 0);

      const contents = await readContents(req.prisma, unit, { spread });
      contents.editable = customerCanEdit(unit.state);
      contents.cando = STATES.filter((to) => customerCanMove(unit.state, to));
      return res.status(200).json(contents);
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Rename — only while the container is in the customer's hands.
router.put(
  "/:storageId",
  [check("storageId").isNumeric(), check("name").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);

    try {
      const unit = await ownUnit(
        req.prisma,
        playerId,
        parseInt(req.params.storageId, 10)
      );
      assertEditable(unit);
      const updated = await req.prisma.storage.update({
        where: { id: unit.id },
        data: { name: String(req.body.name).trim() },
      });
      return res.status(200).json(updated);
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Delete an empty container the customer has in hand.
router.delete(
  "/:storageId",
  [check("storageId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);

    try {
      const unit = await ownUnit(
        req.prisma,
        playerId,
        parseInt(req.params.storageId, 10)
      );
      assertEditable(unit);
      const count = await req.prisma.cardplacement.count({
        where: { storageid: unit.id },
      });
      if (count > 0) {
        return res
          .status(400)
          .json({ message: messages.STORAGE_NOT_EMPTY, cardcount: count });
      }
      await req.prisma.storage.delete({ where: { id: unit.id } });
      return res.status(200).json({ message: messages.STORAGE_DELETED });
    } catch (err) {
      return handle(err, res);
    }
  })
);

// --------------------------------------------------------------------------
// Lifecycle — the customer's half
// --------------------------------------------------------------------------

// Retire (for_sale -> retired) or announce a return (released -> returning).
//
// Retiring is the one that matters: the cards stop being sellable the moment
// the customer asks for the container back, not when it physically leaves.
// Copies already in someone's pick-up bag are NOT affected — those are promised
// to a buyer and are not in the container any more, so they are not the
// customer's to take back.
router.post(
  "/:storageId/state",
  [check("storageId").isNumeric(), check("state").isIn(STATES)],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const target = req.body.state;

    try {
      const unit = await ownUnit(
        req.prisma,
        playerId,
        parseInt(req.params.storageId, 10)
      );
      if (!customerCanMove(unit.state, target)) {
        return res
          .status(400)
          .json({ message: messages.STORAGE_BAD_STATE, state: unit.state });
      }

      // Copies of this container's cards that stay behind with the shop.
      const committed = await req.prisma.cardplacement.count({
        where: { storageid: unit.id, orderlineid: { not: null } },
      });

      const updated = await req.prisma.storage.update({
        where: { id: unit.id },
        data: { state: target },
      });

      return res.status(200).json({
        message: STATE_MESSAGE[target],
        id: updated.id,
        name: updated.name,
        state: updated.state,
        forsale: updated.state === "for_sale",
        editable: customerCanEdit(updated.state),
        cando: STATES.filter((to) => customerCanMove(updated.state, to)),
        // Surfaced so retiring a binder does not look like it lost cards.
        committed,
      });
    } catch (err) {
      return handle(err, res);
    }
  })
);

// --------------------------------------------------------------------------
// Rearranging — only while the container is in the customer's hands
// --------------------------------------------------------------------------

// Put one of the customer's own cards into one of their own containers.
router.post(
  "/:storageId/place",
  [check("storageId").isNumeric(), check("cardid").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);

    try {
      const unit = await ownUnit(
        req.prisma,
        playerId,
        parseInt(req.params.storageId, 10)
      );
      assertEditable(unit);

      // placeCopy does not judge ownership, so check before it writes anything:
      // filing somebody else's card into your own binder would be filing away
      // stock you do not own.
      const card = await req.prisma.card.findUnique({
        where: { id: parseInt(req.body.cardid, 10) },
        include: { collection: { select: { playerid: true } } },
      });
      if (!card) {
        return res.status(404).json({ message: messages.CARD_NOT_FOUND });
      }
      if (card.collection?.playerid !== playerId) {
        return res.status(403).json({ message: messages.CARD_NOT_YOURS });
      }

      const { placement } = await placeCopy(req.prisma, unit, req.body);
      return res.status(201).json(placement);
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Take one of the customer's copies out of one of their containers.
router.delete(
  "/placement/:placementId",
  [check("placementId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);

    const placement = await req.prisma.cardplacement.findUnique({
      where: { id: parseInt(req.params.placementId, 10) },
      include: { storage: true },
    });
    if (!placement || placement.storage.playerid !== playerId) {
      return res.status(404).json({ message: messages.PLACEMENT_NOT_FOUND });
    }
    try {
      assertEditable(placement.storage);
    } catch (err) {
      return handle(err, res);
    }
    // A released container's cards are all uncommitted by construction, but the
    // check costs nothing and the invariant is worth stating out loud.
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    await removePlacement(req.prisma, placement);
    return res.status(200).json({ message: messages.PLACEMENT_REMOVED });
  })
);

// Move a copy between the customer's own containers.
router.put(
  "/placement/:placementId",
  [check("placementId").isNumeric(), check("storageid").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);

    const placement = await req.prisma.cardplacement.findUnique({
      where: { id: parseInt(req.params.placementId, 10) },
      include: { storage: true },
    });
    if (!placement || placement.storage.playerid !== playerId) {
      return res.status(404).json({ message: messages.PLACEMENT_NOT_FOUND });
    }
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    try {
      const target = await ownUnit(
        req.prisma,
        playerId,
        parseInt(req.body.storageid, 10)
      );
      // Both ends have to be in the customer's hands, or the move describes
      // carrying a card into or out of a binder sitting on the shop's shelf.
      assertEditable(placement.storage);
      assertEditable(target);

      return res
        .status(200)
        .json(await movePlacement(req.prisma, placement, target, req.body));
    } catch (err) {
      return handle(err, res);
    }
  })
);

export default router;
