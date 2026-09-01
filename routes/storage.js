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
  shopHolds,
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
  movePlacement,
  setBinderPosition,
  reorderSorted,
  shiftBinderPage,
  reorderPocketStack,
} from "../services/storageContents.js";
import { DEFAULT_FINISH, finishesFor } from "../services/finishes.js";
import { defaultIdentity } from "../services/identity.js";
import { importManaBox } from "../services/manabox.js";
import { isPaperPrinting } from "../services/paper.js";
import {
  removeCopy,
  duplicateCopy,
  discardStandby,
  addPrintingCopy,
  changePrintingCopy,
} from "../services/copies.js";
import { requirePlayerId } from "../middleware/asyncHandler.js";
import { storeName } from "../services/locations.js";

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

// List storage units with a count of what is in them.
//
// `q` filters by container or owner name, `sort`/`dir` order by either, and
// `page`/`limit` page the result — a shop with a wall of binders should not
// pull every one of them on each visit. With `page` present the response is
// `{ units, total }`; without it the whole (filtered, sorted) array comes
// back as it always did, so older callers keep working.
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const prisma = req.prisma;

    const q = String(req.query.q ?? "").trim();
    let where = {};
    if (q) {
      // Accent-insensitive: "martin" has to find Martín. Prisma's
      // `insensitive` folds case only, so the candidate ids come from SQL
      // that strips the Spanish diacritics on both sides.
      const folded =
        "%" +
        q.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "") +
        "%";
      const hits = await prisma.$queryRaw`
        SELECT s.id FROM storage s
        LEFT JOIN player p ON p.id = s.playerid
        WHERE translate(lower(s.name), 'áéíóúüñ', 'aeiouun') LIKE ${folded}
           OR translate(lower(coalesce(s.storename, '')), 'áéíóúüñ', 'aeiouun') LIKE ${folded}
           OR translate(lower(coalesce(p.name, '')), 'áéíóúüñ', 'aeiouun') LIKE ${folded}`;
      where = { id: { in: hits.map((h) => h.id) } };
    }

    const dir = req.query.dir === "desc" ? "desc" : "asc";
    const orderBy =
      req.query.sort === "owner"
        ? [{ player: { name: dir } }, { name: "asc" }]
        : req.query.sort === "name"
          ? [{ name: dir }]
          : [{ playerid: "asc" }, { name: "asc" }];

    const paged = req.query.page !== undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const [units, total] = await Promise.all([
      prisma.storage.findMany({
        where,
        include: {
          player: { select: { id: true, name: true } },
          // Copies in a pick-up bag are not physically in the container, so
          // they must not be counted as being in it — the contents view
          // already excludes them, and a count that disagreed would look
          // like lost cards.
          _count: {
            select: { cardplacement: { where: { orderlineid: null } } },
          },
        },
        orderBy,
        ...(paged ? { skip: (page - 1) * limit, take: limit } : {}),
      }),
      paged ? prisma.storage.count({ where }) : Promise.resolve(0),
    ]);

    const shaped = (u) => ({
        id: u.id,
        // The store's label; the owner column beside it says whose it is.
        name: storeName(u),
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
        // Whether the shop physically holds it, and so may rename or
        // rearrange it at all.
        inshop: u.state !== "released",
        // A customer's container is never the shop's to delete — see the
        // DELETE route. The UI reads this rather than re-deriving the rule.
        deletable: u.playerid === null && u.state !== "released",
    });

    return res
      .status(200)
      .json(paged ? { units: units.map(shaped), total } : units.map(shaped));
  })
);

// Create a storage unit — the shop's own, always.
//
// A customer's container is created by the customer from /mystorage, because
// it starts in THEIR hands (released) and only they know what they own. The
// shop creating furniture on a customer's behalf would invent a container the
// customer never brought in, so no owner is accepted here.
router.post(
  "/",
  [check("name").trim().notEmpty(), check("type").isIn(TYPES)],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;

    const unit = await prisma.storage.create({
      data: {
        name: String(req.body.name).trim(),
        type: req.body.type,
        playerid: null,
        // Created by the shop, so it is on the shelf and for sale.
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
      // The store renames its OWN label. For a customer's container that is
      // `storename` — the owner's `name` is theirs and never touched from
      // here. Shop furniture has only the one name.
      if (unit.playerid === null) {
        data.name = req.body.name.trim();
      } else {
        data.storename = req.body.name.trim();
      }
    }
    if (!Object.keys(data).length) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }

    const updated = await prisma.storage.update({ where: { id }, data });
    return res.status(200).json({ ...updated, name: storeName(updated) });
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
    // A customer's container is theirs. The shop can hand it back, but deleting
    // it would destroy the record of where their cards live — and the customer
    // has no way to object. Emptying it first does not help: the container is
    // still the customer's property, not the shop's to dispose of.
    if (unit.playerid !== null) {
      return res.status(400).json({ message: messages.STORAGE_CUSTOMER_OWNED });
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
      name: storeName(updated),
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

    const contents = await readContents(req.prisma, unit, { spread });
    // The admin app calls containers by the store's label; the owner already
    // rides along in `contents.owner` for the page's tag.
    contents.name = storeName(unit);
    // Two levels of touch. `editable`: the store adds and removes cards only
    // in its own furniture — a customer's container is displayed and sold
    // from, never restocked behind their back. `arrangeable`: whoever
    // physically holds a binder may rearrange it, so a customer's container on
    // the shop's shelf can be tidied — positions change, the cards do not.
    contents.editable = unit.playerid === null;
    contents.arrangeable = contents.editable || shopHolds(unit.state);
    return res.status(200).json(contents);
  })
);

// --------------------------------------------------------------------------
// Placing and removing copies — the shop's OWN containers only
// --------------------------------------------------------------------------

// The store adds and removes cards only in its own furniture. A customer's
// container holds the customer's cards, and every change to those goes through
// a flow they see: a sale, a withdrawal, a return — never a quiet edit.
function assertShopOwned(unit) {
  if (unit.playerid !== null) {
    throw new ContentsError(messages.STORAGE_EDIT_SHOP_ONLY);
  }
}

// Rearranging is gentler than editing: positions change, the cards do not.
// Whoever physically holds a binder may tidy it, so a customer's container on
// the shop's shelf qualifies — but one in the customer's hands (released, or
// returning and not yet handed over) does not.
function assertShopMayArrange(unit) {
  if (unit.playerid !== null && !shopHolds(unit.state)) {
    throw new ContentsError(messages.STORAGE_WITH_CUSTOMER);
  }
}

// Turn the errors the helpers throw into responses.
function handle(err, res) {
  if (err instanceof ContentsError) {
    return res.status(err.status).json({ message: err.message });
  }
  throw err;
}

// Place one copy of an existing card into one of the shop's units.
// Body: { cardid, copyindex, page, pocket, sequence, standby }
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

    try {
      assertShopOwned(unit);
      const { placement } = await placeCopy(req.prisma, unit, req.body);
      return res.status(201).json(placement);
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Take a copy out of one of the shop's units.
//
// Removes the COPY, not just its address — a card with no container is what
// this model no longer allows, so taking it out of the binder takes it out of
// stock. Same semantics as the customer's remove.
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
    // Dropping the row would erase the only record of where a bagged card goes
    // back to if the order falls through.
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    try {
      assertShopOwned(placement.storage);
      const result = await removeCopy(req.prisma, placement);
      return res.status(200).json({
        message: messages.PLACEMENT_REMOVED,
        cardDeleted: result.cardDeleted,
      });
    } catch (err) {
      return handle(err, res);
    }
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
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    try {
      // Both ends of the move must be the shop's own furniture.
      assertShopOwned(placement.storage);
      assertShopOwned(unit);
      return res
        .status(200)
        .json(await movePlacement(prisma, placement, unit, req.body));
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Put a copy somewhere in one of the shop's binders — a pocket, or the
// stand-by area. Body: { page, pocket } to file it, { standby: true } to lift
// it out. The mechanics are shared with the customer's binder editor.
router.put(
  "/placement/:placementId/position",
  [check("placementId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;

    const placement = await prisma.cardplacement.findUnique({
      where: { id: parseInt(req.params.placementId, 10) },
      include: { storage: true },
    });
    if (!placement) {
      return res.status(404).json({ message: messages.PLACEMENT_NOT_FOUND });
    }
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    try {
      assertShopMayArrange(placement.storage);
      return res
        .status(200)
        .json(await setBinderPosition(prisma, placement, req.body));
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Another copy of the same card, in the stand-by area of the shop's binder.
// Change ONE copy into another printing or finish of the same card. The
// placement keeps its exact spot; only the copy's identity moves. Body:
// { scryfallid, variant }. Shop-owned containers only, like duplicate and
// remove — it changes the collection, not the arrangement.
router.put(
  "/placement/:placementId/version",
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
    if (placement.orderlineid !== null) {
      return res.status(400).json({ message: messages.PLACEMENT_COMMITTED });
    }

    try {
      assertShopOwned(placement.storage);
      const scryfallid = String(req.body.scryfallid ?? "").trim();
      const variant = String(req.body.variant ?? "").trim();
      const printing = await req.prisma.cardgeneral.findUnique({
        where: { scryfallid },
      });
      if (!printing) {
        return res.status(404).json({ message: messages.CARD_NOT_FOUND });
      }
      if (!isPaperPrinting(printing)) {
        return res.status(400).json({ message: messages.CARD_DIGITAL_ONLY });
      }
      if (!finishesFor(printing).includes(variant)) {
        return res.status(400).json({
          message: messages.FINISH_NOT_AVAILABLE,
          finishes: finishesFor(printing),
        });
      }
      const moved = await changePrintingCopy(req.prisma, placement, {
        scryfallid,
        variant,
      });
      return res.status(200).json(moved);
    } catch (err) {
      return handle(err, res);
    }
  })
);

router.post(
  "/placement/:placementId/duplicate",
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

    try {
      assertShopOwned(placement.storage);
      const created = await duplicateCopy(req.prisma, placement);
      return res.status(201).json(created);
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Reorder one of the shop's sorted boxes.
// Body: { placementids: [...] } in the order they should sit.
router.put(
  "/:storageId/order",
  [check("storageId").isNumeric()],
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

    try {
      assertShopMayArrange(unit);
      const ordered = await reorderSorted(req.prisma, unit, req.body.placementids);
      return res.status(200).json({ ordered });
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Add one copy of a printing to a container the shop holds.
//
// Reorder the stack inside one pocket. Body: { page, pocket,
// placementids } — the visible stack in its new order, front (the card you
// see) first. Same arranging gate as any other move.
router.put(
  "/:storageId/pocket/order",
  [check("storageId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    try {
      const unit = await prisma.storage.findUnique({
        where: { id: parseInt(req.params.storageId, 10) },
      });
      if (!unit) {
        return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
      }
      assertShopMayArrange(unit);
      await reorderPocketStack(
        prisma,
        unit,
        parseInt(req.body.page, 10),
        parseInt(req.body.pocket, 10),
        req.body.placementids
      );
      return res.status(200).json({ ok: true });
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Slide the cards from one pocket onward a space ahead or back on their
// page; an edge stack is kicked to the stand-by area. Body: { frompocket,
// direction } —
// "ahead" or "back". Physically held is the bar, like any other arranging.
router.post(
  "/:storageId/page/:page/shift",
  [check("storageId").isNumeric(), check("page").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const prisma = req.prisma;
    const unit = await prisma.storage.findUnique({
      where: { id: parseInt(req.params.storageId, 10) },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }
    try {
      assertShopMayArrange(unit);
      await shiftBinderPage(
        prisma,
        unit,
        parseInt(req.params.page, 10),
        parseInt(req.body.frompocket, 10),
        String(req.body.direction ?? "")
      );
      return res.status(200).json({ ok: true });
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Import a ManaBox scan into this container. Body: { csv } — the app's CSV
// export, verbatim. Same possession and ownership rules as /add below; the
// per-row semantics (binder pockets, empty lines, condition/language kept
// faithfully) live in services/manabox.js.
router.post(
  "/:storageId/import",
  [check("storageId").isNumeric()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty() || typeof req.body.csv !== "string") {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    const unit = await prisma.storage.findUnique({
      where: { id: parseInt(req.params.storageId, 10) },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }

    try {
      assertShopMayArrange(unit);

      // Shop-owned containers file into the acting staff member's collection;
      // a customer's container into the customer's. If that collection is
      // missing this used to 404 with a generic message and NO server log —
      // which is exactly how a staff/owner account created outside the
      // registration flow (no collection ever made) turned into an
      // undiagnosable "error genérico". Log it, and name the real problem.
      const collectionOwnerId = unit.playerid ?? playerId;
      const collection = await prisma.collection.findFirst({
        where: { playerid: collectionOwnerId, active: true },
        select: { id: true },
      });
      if (!collection) {
        console.error(
          `No active collection for player ${collectionOwnerId} while filing ` +
            `into storage ${unit.id}`
        );
        return res.status(404).json({ message: messages.STOCK_NO_COLLECTION });
      }

      const result = await importManaBox(
        prisma,
        unit,
        collection.id,
        req.body.csv
      );
      if (result.badFile) {
        return res.status(400).json({ message: messages.MANABOX_BAD_FILE });
      }
      if (result.tooLarge) {
        return res.status(400).json({ message: messages.MANABOX_TOO_LARGE });
      }
      return res.status(200).json(result);
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Whose collection the card lands in follows whose container it is. The
// shop's own furniture takes the CALLING staff member's stock (shop stock is
// the owner's and staff's collections — see assertOwnerMayHold). A customer's
// container held by the shop takes the CUSTOMER's cards: them walking in with
// five more cards for their consigned binder is the everyday case, and
// cycling the whole container home and back just to add them was theatre.
// Same landing rules as the customer's add — a binder's copy goes to
// stand-by, a sorted box's to the front.
router.post(
  "/:storageId/add",
  [check("storageId").isNumeric(), check("scryfallid").trim().notEmpty()],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: messages.PARAMETERS_ERROR });
    }
    const playerId = requirePlayerId(req);
    const prisma = req.prisma;

    const unit = await prisma.storage.findUnique({
      where: { id: parseInt(req.params.storageId, 10) },
    });
    if (!unit) {
      return res.status(404).json({ message: messages.STORAGE_NOT_FOUND });
    }

    try {
      // Physically held is the bar (for_sale or retired) — recording a card
      // into a binder in the customer's living room would be fiction.
      assertShopMayArrange(unit);

      const scryfallid = String(req.body.scryfallid).trim();
      // The UI no longer asks for condition or language — a manual add is
      // assumed NM English. Explicit values (a future ManaBox import) still
      // land as sent; the columns keep being tracked either way.
      const assumed = await defaultIdentity(prisma);
      const conditionid =
        parseInt(req.body.conditionid, 10) || assumed.conditionid;
      const languageid =
        parseInt(req.body.languageid, 10) || assumed.languageid;
      const variant = String(req.body.variant ?? DEFAULT_FINISH).trim();

      const printing = await prisma.cardgeneral.findUnique({
        where: { scryfallid },
      });
      if (!printing) {
        return res.status(404).json({ message: messages.CARD_NOT_FOUND });
      }
      if (!isPaperPrinting(printing)) {
        return res.status(400).json({ message: messages.CARD_DIGITAL_ONLY });
      }
      const finishes = finishesFor(printing);
      if (!finishes.includes(variant)) {
        return res.status(400).json({
          message: messages.FINISH_NOT_AVAILABLE,
          finishes,
        });
      }

      // Shop-owned containers file into the acting staff member's collection;
      // a customer's container into the customer's. If that collection is
      // missing this used to 404 with a generic message and NO server log —
      // which is exactly how a staff/owner account created outside the
      // registration flow (no collection ever made) turned into an
      // undiagnosable "error genérico". Log it, and name the real problem.
      const collectionOwnerId = unit.playerid ?? playerId;
      const collection = await prisma.collection.findFirst({
        where: { playerid: collectionOwnerId, active: true },
        select: { id: true },
      });
      if (!collection) {
        console.error(
          `No active collection for player ${collectionOwnerId} while filing ` +
            `into storage ${unit.id}`
        );
        return res.status(404).json({ message: messages.STOCK_NO_COLLECTION });
      }

      const placement = await addPrintingCopy(prisma, unit, collection.id, {
        scryfallid,
        conditionid,
        languageid,
        variant,
      });

      return res.status(201).json(placement);
    } catch (err) {
      return handle(err, res);
    }
  })
);

// Throw away whatever is left in a binder's stand-by area — called when
// staff finish editing with cards taken out of pockets and never put back.
// Same bar as adding: whatever the shop physically holds, it can tidy up —
// including discarding a card it just added to a customer's binder by
// mistake, which is the mirror of being allowed to add it.
router.post(
  "/:storageId/discard-standby",
  [check("storageId").isNumeric()],
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

    try {
      assertShopMayArrange(unit);
      const removed = await discardStandby(req.prisma, unit.id);
      return res.status(200).json({ removed });
    } catch (err) {
      return handle(err, res);
    }
  })
);

export default router;
export { POCKETS_PER_PAGE, spreadForPage, pagesInSpread };
