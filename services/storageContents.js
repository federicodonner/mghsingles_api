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

    const where = { storageid: unit.id, orderlineid: null };
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
    base.cardcount = placements.length;
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

// Put one copy of a card into a container.
//
// - binder: page and pocket required; depth is assigned at the back of the stack
// - sorted_box: sequence optional, appended to the end when omitted
// - unsorted_box: no coordinates at all
export async function placeCopy(prisma, unit, body) {
  const cardid = parseInt(body.cardid, 10);
  const card = await prisma.card.findUnique({
    where: { id: cardid },
    include: { cardplacement: true, collection: { select: { playerid: true } } },
  });
  if (!card) throw new ContentsError(messages.CARD_NOT_FOUND, 404);

  // Validate the coordinates before allocating a copy, so a bad pocket reports
  // a bad pocket rather than whatever the copy allocator hits first.
  let page = null;
  let pocket = null;
  if (unit.type === "binder") {
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

  if (unit.type === "binder") {
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

// Move an existing placement to a new spot, in this container or another.
export async function movePlacement(prisma, placement, unit, body) {
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
