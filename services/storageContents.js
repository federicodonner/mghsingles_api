// Reading and rearranging what is inside a container.
//
// Both the shop (routes/storage.js) and the container's owner
// (routes/mystorage.js) do exactly these operations; only the guards around
// them differ. They live here so the two paths cannot drift — a second copy of
// the depth allocator would eventually allocate a different depth.
//
// Nothing in this file decides WHO may call it. That is the route's job.
import messages from "../data/messages.js";

export const POCKETS_PER_PAGE = 9; // 3x3

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

export const CARD_INCLUDE = {
  card: {
    include: {
      cardgeneral: true,
      cardcondition: { select: { name: true } },
      cardlanguage: { select: { name: true } },
      collection: {
        select: {
          id: true,
          playerid: true,
          player: { select: { id: true, name: true } },
        },
      },
    },
  },
};

// Flatten a placement + its card into what the UI renders.
export function describePlacement(placement) {
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

// The summary every view puts at the top of a container.
export function describeUnit(unit) {
  return {
    id: unit.id,
    name: unit.name,
    type: unit.type,
    state: unit.state,
    forsale: unit.state === "for_sale",
    owner: unit.player ? { id: unit.player.id, name: unit.player.name } : null,
  };
}

// Everything in a container, shaped for the type of container it is.
//
// `spread` (binders only) limits the read to one facing pair. Copies sitting in
// a pick-up bag are excluded everywhere: they are physically in a bag on the
// counter, not in the pocket their placement still records.
export async function readContents(prisma, unit, { spread } = {}) {
  const base = describeUnit(unit);

  if (unit.type === "binder") {
    const maxPage = await prisma.cardplacement.aggregate({
      where: { storageid: unit.id, orderlineid: null },
      _max: { page: true },
    });
    base.maxPage = maxPage._max.page ?? 1;
    base.maxSpread = spreadForPage(base.maxPage);

    // Filed cards only. A card with no page and no pocket is in the stand-by
    // area, which is returned separately below — putting it in a pocket render
    // would mean inventing a pocket for it.
    const where = {
      storageid: unit.id,
      orderlineid: null,
      page: { not: null },
    };
    if (spread !== null && spread !== undefined) {
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
      spread !== null && spread !== undefined
        ? pagesInSpread(spread).map(renderPage)
        : [...byPage.keys()].sort((a, b) => a - b).map(renderPage);

    // Cards lifted out of a pocket and not yet put back. Persisted, so a
    // half-finished sort survives a reload rather than silently refiling
    // itself or vanishing.
    const standby = await prisma.cardplacement.findMany({
      where: { storageid: unit.id, orderlineid: null, page: null, pocket: null },
      include: CARD_INCLUDE,
      orderBy: { id: "asc" },
    });
    base.standby = standby.map(describePlacement);

    base.cardcount = placements.length + standby.length;
    return base;
  }

  // Boxes: a flat list. Sorted boxes carry a sequence, unsorted ones do not.
  const placements = await prisma.cardplacement.findMany({
    where: { storageid: unit.id, orderlineid: null },
    include: CARD_INCLUDE,
    orderBy: unit.type === "sorted_box" ? { sequence: "asc" } : { id: "asc" },
  });
  base.cards = placements.map(describePlacement);
  base.cardcount = placements.length;
  return base;
}

// Thrown for the ordinary "you asked for something impossible" cases, so the
// caller can turn one into a 400 without every helper returning a tuple.
export class ContentsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// A customer's card lives in that customer's containers, full stop. The
// shop's own furniture (no owner) holds only the shop's own stock — owner and
// staff collections — never a customer's card: the shop displays the
// customer's whole binder, it does not refile their cards into its own. The
// one place a copy sits outside its owner's container is a pick-up bag, and a
// bag is an orderline, not a container.
async function assertOwnerMayHold(prisma, card, unit) {
  const cardOwner = card.collection?.playerid ?? null;
  if (unit.playerid !== null) {
    if (unit.playerid !== cardOwner) {
      throw new ContentsError(messages.CARD_WRONG_CONTAINER);
    }
    return;
  }
  const owner = cardOwner
    ? await prisma.player.findUnique({
        where: { id: cardOwner },
        select: { role: true },
      })
    : null;
  if (!owner || owner.role === "customer") {
    throw new ContentsError(messages.CARD_WRONG_CONTAINER);
  }
}

// Slide the cards FROM one pocket onward a space ahead or back on their page.
//
// The hovered card is the leader: "ahead" pushes it and everything after it
// on the page one pocket forward — making room where it stood — and "back"
// pulls them all one pocket toward the front. A stack pushed past the last
// pocket (or pulled out of the first) has nowhere to go, so it is kicked to
// the stand-by area — really (page null on the server), because the shift is
// a persisted rearrangement and the kicked card needs a new pocket anyway.
// Pulling back INTO an occupied pocket stacks behind what is already there,
// the same way a dragged card lands on an occupied pocket.
//
// A copy in the affected range that is set aside for an order refuses the
// shift: somebody may be walking to its recorded coordinates right now, same
// rule as moving that copy directly.
export async function shiftBinderPage(prisma, unit, page, fromPocket, direction) {
  const ahead = direction === "ahead";
  if (
    unit.type !== "binder" ||
    !(page >= 1) ||
    !(fromPocket >= 1 && fromPocket <= POCKETS_PER_PAGE) ||
    (!ahead && direction !== "back")
  ) {
    throw new ContentsError(messages.PARAMETERS_ERROR);
  }

  const committed = await prisma.cardplacement.findFirst({
    where: {
      storageid: unit.id,
      page,
      pocket: { gte: fromPocket },
      orderlineid: { not: null },
    },
    select: { id: true },
  });
  if (committed) {
    throw new ContentsError(messages.PLACEMENT_COMMITTED);
  }

  const ops = [];
  if (ahead) {
    // Kick first: the kicked rows lose their page, so the blanket move
    // below cannot touch them. Every other move lands in a pocket its own
    // occupant is vacating, so nothing merges. Stacks travel whole.
    ops.push(
      prisma.cardplacement.updateMany({
        where: { storageid: unit.id, page, pocket: POCKETS_PER_PAGE },
        data: { page: null, pocket: null, depth: null },
      }),
      prisma.cardplacement.updateMany({
        where: {
          storageid: unit.id,
          page,
          pocket: { gte: fromPocket, lt: POCKETS_PER_PAGE },
        },
        data: { pocket: { increment: 1 } },
      })
    );
  } else if (fromPocket === 1) {
    ops.push(
      prisma.cardplacement.updateMany({
        where: { storageid: unit.id, page, pocket: 1 },
        data: { page: null, pocket: null, depth: null },
      }),
      prisma.cardplacement.updateMany({
        where: { storageid: unit.id, page, pocket: { gt: 1 } },
        data: { pocket: { decrement: 1 } },
      })
    );
  } else {
    // The leader lands in a pocket that is NOT vacating — it may be
    // occupied. Stack behind its occupants: bump the incoming depths past
    // the deepest card already there, then move.
    const deepest = await prisma.cardplacement.aggregate({
      where: { storageid: unit.id, page, pocket: fromPocket - 1 },
      _max: { depth: true },
    });
    const behind = deepest._max.depth ?? 0;
    if (behind > 0) {
      ops.push(
        prisma.cardplacement.updateMany({
          where: { storageid: unit.id, page, pocket: fromPocket },
          data: { depth: { increment: behind } },
        })
      );
    }
    ops.push(
      prisma.cardplacement.updateMany({
        where: { storageid: unit.id, page, pocket: { gte: fromPocket } },
        data: { pocket: { decrement: 1 } },
      })
    );
  }
  await prisma.$transaction(ops);
}

// Reorder the stack inside one binder pocket.
//
// `placementids` is the pocket's visible stack in its new order, front first —
// depth 1 is the card you SEE in the pocket. Copies set aside for an order are
// not offered in the dialog and cannot be reordered; they keep their relative
// order behind the visible stack, so their depths stay meaningful without ever
// colliding.
export async function reorderPocketStack(prisma, unit, page, pocket, placementids) {
  if (
    unit.type !== "binder" ||
    !(page >= 1) ||
    !(pocket >= 1 && pocket <= POCKETS_PER_PAGE) ||
    !Array.isArray(placementids)
  ) {
    throw new ContentsError(messages.PARAMETERS_ERROR);
  }

  const inPocket = await prisma.cardplacement.findMany({
    where: { storageid: unit.id, page, pocket },
  });
  const visible = inPocket.filter((pl) => pl.orderlineid === null);
  const ids = placementids.map((id) => parseInt(id, 10));
  const visibleIds = new Set(visible.map((pl) => pl.id));
  // The new order must be exactly the visible stack — nothing missing,
  // nothing foreign — or a stale dialog could scramble a pocket it is not
  // looking at.
  if (
    ids.length !== visible.length ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => visibleIds.has(id))
  ) {
    throw new ContentsError(messages.PARAMETERS_ERROR);
  }

  const bagged = inPocket
    .filter((pl) => pl.orderlineid !== null)
    .sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));

  await prisma.$transaction([
    ...ids.map((id, i) =>
      prisma.cardplacement.update({ where: { id }, data: { depth: i + 1 } })
    ),
    ...bagged.map((pl, i) =>
      prisma.cardplacement.update({
        where: { id: pl.id },
        data: { depth: ids.length + i + 1 },
      })
    ),
  ]);
}

// Put one copy of a card into a container.
//
// - binder: page and pocket required — or `standby: true` to leave the copy in
//   the binder's stand-by zone (page/pocket null) to be dragged into a pocket
// - sorted_box: sequence optional, appended to the end when omitted
// - unsorted_box: no coordinates at all
export async function placeCopy(prisma, unit, body) {
  const cardid = parseInt(body.cardid, 10);
  const card = await prisma.card.findUnique({
    where: { id: cardid },
    include: { cardplacement: true, collection: { select: { playerid: true } } },
  });
  if (!card) throw new ContentsError(messages.CARD_NOT_FOUND, 404);

  await assertOwnerMayHold(prisma, card, unit);

  // Validate the coordinates before allocating a copy, so a bad pocket reports
  // a bad pocket rather than whatever the copy allocator hits first.
  let page = null;
  let pocket = null;
  if (unit.type === "binder" && !body.standby) {
    page = parseInt(body.page, 10);
    pocket = parseInt(body.pocket, 10);
    if (!(page >= 1) || !(pocket >= 1 && pocket <= POCKETS_PER_PAGE)) {
      throw new ContentsError(messages.PARAMETERS_ERROR);
    }
  } else if (unit.type === "sorted_box" && body.sequence !== undefined) {
    if (!(parseInt(body.sequence, 10) >= 1)) {
      throw new ContentsError(messages.PARAMETERS_ERROR);
    }
  }

  // Pick the copy to place: the caller may name one, otherwise take the lowest
  // index that is not already somewhere.
  const taken = new Set(card.cardplacement.map((pl) => pl.copyindex));
  let copyindex;
  if (body.copyindex !== undefined) {
    copyindex = parseInt(body.copyindex, 10);
    if (!(copyindex >= 1 && copyindex <= card.quantity)) {
      throw new ContentsError(messages.PARAMETERS_ERROR);
    }
    if (taken.has(copyindex)) {
      throw new ContentsError(messages.COPY_ALREADY_PLACED);
    }
  } else {
    copyindex = null;
    for (let i = 1; i <= card.quantity; i++) {
      if (!taken.has(i)) {
        copyindex = i;
        break;
      }
    }
    if (copyindex === null) throw new ContentsError(messages.ALL_COPIES_PLACED);
  }

  const data = { cardid, copyindex, storageid: unit.id };

  if (unit.type === "binder" && page !== null) {
    // Pockets hold several cards; the new one goes behind whatever is there.
    const deepest = await prisma.cardplacement.aggregate({
      where: { storageid: unit.id, page, pocket },
      _max: { depth: true },
    });
    data.page = page;
    data.pocket = pocket;
    data.depth = (deepest._max.depth ?? 0) + 1;
  } else if (unit.type === "sorted_box") {
    if (body.sequence !== undefined) {
      data.sequence = parseInt(body.sequence, 10);
      // Make room by shifting everything at or after this position back.
      await prisma.cardplacement.updateMany({
        where: { storageid: unit.id, sequence: { gte: data.sequence } },
        data: { sequence: { increment: 1 } },
      });
    } else {
      const last = await prisma.cardplacement.aggregate({
        where: { storageid: unit.id },
        _max: { sequence: true },
      });
      data.sequence = (last._max.sequence ?? 0) + 1;
    }
  }

  return { placement: await prisma.cardplacement.create({ data }), card };
}

// Take a copy out, closing the gap it leaves so positions stay contiguous.
export async function removePlacement(prisma, placement) {
  await prisma.$transaction(async (tx) => {
    await tx.cardplacement.delete({ where: { id: placement.id } });

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
}

// Put a copy somewhere in its binder — a pocket, or the stand-by area.
//
// Body: { page, pocket } to file it, or { standby: true } to lift it out.
// One operation for both because they are the same gesture: dragging a card
// somewhere. The stand-by area is a real position (page and pocket null), not
// a UI holding pen, so a half-finished sort survives a reload.
//
// Shared by the customer (their own binders) and the shop (its furniture);
// the caller has already checked whose binder this is and who may touch it.
export async function setBinderPosition(prisma, placement, body) {
  if (placement.storage.type !== "binder") {
    throw new ContentsError(messages.PARAMETERS_ERROR);
  }

  const toStandby = body.standby === true;
  let data;
  if (toStandby) {
    data = { page: null, pocket: null, depth: null, sequence: null };
  } else {
    const page = parseInt(body.page, 10);
    const pocket = parseInt(body.pocket, 10);
    if (!(page >= 1) || !(pocket >= 1 && pocket <= POCKETS_PER_PAGE)) {
      throw new ContentsError(messages.PARAMETERS_ERROR);
    }
    // A pocket holds a stack, so a card dropped on an occupied one goes
    // behind what is already there rather than displacing it.
    const deepest = await prisma.cardplacement.aggregate({
      where: {
        storageid: placement.storageid,
        page,
        pocket,
        NOT: { id: placement.id },
      },
      _max: { depth: true },
    });
    data = {
      page,
      pocket,
      depth: (deepest._max.depth ?? 0) + 1,
      sequence: null,
    };
  }

  const updated = await prisma.cardplacement.update({
    where: { id: placement.id },
    data,
  });

  // Leaving a pocket leaves a gap in its stack.
  if (placement.pocket !== null) {
    await prisma.cardplacement.updateMany({
      where: {
        storageid: placement.storageid,
        page: placement.page,
        pocket: placement.pocket,
        depth: { gt: placement.depth },
      },
      data: { depth: { decrement: 1 } },
    });
  }

  return updated;
}

// Reorder a sorted box to exactly the sequence of ids given.
//
// The whole order rather than "move item 3 to position 7", so the result is
// exactly what the caller sees on screen and two reorders cannot interleave
// into a sequence nobody asked for. Ids not in this box are ignored, so a
// stray id cannot drag a card out of another container by being listed here.
export async function reorderSorted(prisma, unit, rawIds) {
  if (unit.type !== "sorted_box") {
    throw new ContentsError(messages.STORAGE_NOT_SORTED);
  }

  const ids = (rawIds ?? []).map((n) => parseInt(n, 10)).filter((n) => n > 0);

  const mine = await prisma.cardplacement.findMany({
    where: { storageid: unit.id, id: { in: ids } },
    select: { id: true },
  });
  const allowed = new Set(mine.map((p) => p.id));

  await prisma.$transaction(
    ids
      .filter((id) => allowed.has(id))
      .map((id, index) =>
        prisma.cardplacement.update({
          where: { id },
          data: { sequence: index + 1 },
        })
      )
  );

  return allowed.size;
}

// Move an existing placement to a new spot, in this container or another.
export async function movePlacement(prisma, placement, unit, body) {
  // Only when actually changing container is ownership in question.
  if (unit.id !== placement.storageid) {
    const card = await prisma.card.findUnique({
      where: { id: placement.cardid },
      include: { collection: { select: { playerid: true } } },
    });
    await assertOwnerMayHold(prisma, card, unit);
  }

  const data = {
    storageid: unit.id,
    page: null,
    pocket: null,
    depth: null,
    sequence: null,
  };

  if (unit.type === "binder") {
    const page = parseInt(body.page, 10);
    const pocket = parseInt(body.pocket, 10);
    if (!(page >= 1) || !(pocket >= 1 && pocket <= POCKETS_PER_PAGE)) {
      throw new ContentsError(messages.PARAMETERS_ERROR);
    }
    const deepest = await prisma.cardplacement.aggregate({
      where: { storageid: unit.id, page, pocket, NOT: { id: placement.id } },
      _max: { depth: true },
    });
    data.page = page;
    data.pocket = pocket;
    data.depth = (deepest._max.depth ?? 0) + 1;
  } else if (unit.type === "sorted_box") {
    const last = await prisma.cardplacement.aggregate({
      where: { storageid: unit.id, NOT: { id: placement.id } },
      _max: { sequence: true },
    });
    data.sequence =
      body.sequence !== undefined
        ? parseInt(body.sequence, 10)
        : (last._max.sequence ?? 0) + 1;
  }

  return prisma.cardplacement.update({ where: { id: placement.id }, data });
}
