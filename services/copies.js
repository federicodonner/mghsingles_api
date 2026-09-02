// A placement IS a copy.
//
// `card.quantity` and the number of `cardplacement` rows used to drift: a card
// could say four copies and have three placements, leaving one real, owned and
// nowhere. Now every copy has a place, and the two numbers are kept equal by
// going through this module instead of writing either one directly.
//
// The consequences, stated plainly:
//
//   * removing a placement removes a copy — the card row disappears at zero
//   * duplicating a placement adds a copy
//   * creating a card with quantity N creates N placements
//
// A copy in a customer's pick-up bag still has its placement (with an
// `orderlineid`), so it is still a copy and still counted. It stops being one
// when the order completes and the card physically leaves the shop.
import messages from "../data/messages.js";
import { ContentsError } from "./storageContents.js";
import { applyFixedPrice, applyReferencePrices } from "./pricing.js";

// Where a copy sits while its owner decides — a binder placement with no page
// and no pocket.
//
// Persisted rather than kept in the browser so it survives a reload, and so
// "discard what is left in the stand-by area" is a real operation rather than
// an accident of closing a tab. Only binders have one: a sorted box orders by
// sequence and an unsorted box has no positions at all, so neither has anywhere
// for a card to be "not yet filed".
export const isStandby = (placement) =>
  placement.page === null && placement.pocket === null;

export const STANDBY_WHERE = { page: null, pocket: null };

// Remove one copy: the placement, and the quantity that counted it.
export async function removeCopy(prisma, placement) {
  return prisma.$transaction(async (tx) => {
    await tx.cardplacement.delete({ where: { id: placement.id } });

    // Close the gap so positions stay contiguous.
    if (placement.storage?.type === "binder" && placement.pocket !== null) {
      await tx.cardplacement.updateMany({
        where: {
          storageid: placement.storageid,
          page: placement.page,
          pocket: placement.pocket,
          depth: { gt: placement.depth },
        },
        data: { depth: { decrement: 1 } },
      });
    } else if (placement.storage?.type === "sorted_box") {
      await tx.cardplacement.updateMany({
        where: {
          storageid: placement.storageid,
          sequence: { gt: placement.sequence },
        },
        data: { sequence: { decrement: 1 } },
      });
    }

    const card = await tx.card.findUnique({
      where: { id: placement.cardid },
      include: { _count: { select: { cardplacement: true } } },
    });
    if (!card) return { removed: 1, cardDeleted: false };

    // The last copy takes the card row with it. Keeping a zero-quantity row
    // would be a card the customer owns none of.
    if (card._count.cardplacement === 0) {
      await tx.card.delete({ where: { id: card.id } });
      return { removed: 1, cardDeleted: true };
    }

    await tx.card.update({
      where: { id: card.id },
      data: { quantity: card._count.cardplacement },
    });
    return { removed: 1, cardDeleted: false };
  });
}

// Add one more copy of the same card, in the stand-by area.
//
// For someone who owns three of a card and is filing them into different
// pockets: they add it once and duplicate it, rather than searching for the
// same printing three times.
export async function duplicateCopy(prisma, placement) {
  return prisma.$transaction(async (tx) => {
    const card = await tx.card.findUnique({
      where: { id: placement.cardid },
      include: { _count: { select: { cardplacement: true } } },
    });
    if (!card) throw new ContentsError(messages.CARD_NOT_FOUND, 404);

    // copyindex is unique per card, so the new copy takes the next free one
    // rather than reusing a number a sibling already holds.
    const highest = await tx.cardplacement.aggregate({
      where: { cardid: card.id },
      _max: { copyindex: true },
    });

    const created = await tx.cardplacement.create({
      data: {
        cardid: card.id,
        copyindex: (highest._max.copyindex ?? 0) + 1,
        storageid: placement.storageid,
        ...STANDBY_WHERE,
        depth: null,
        sequence: null,
      },
    });

    await tx.card.update({
      where: { id: card.id },
      data: { quantity: card._count.cardplacement + 1 },
    });

    return created;
  });
}

// Turn ONE copy into a different printing (or finish) of the same card.
//
// The placement stays exactly where it is — same pocket, depth or sequence —
// only its identity moves: the copy leaves its card row and joins (or
// creates) the row for the chosen printing, keeping its condition and
// language. The freshly created row is priced on the spot, the same as any
// other birth. Choosing the version the copy already is returns unchanged.
export async function changePrintingCopy(prisma, placement, { scryfallid, variant }) {
  return prisma.$transaction(async (tx) => {
    const source = await tx.card.findUnique({
      where: { id: placement.cardid },
      include: { _count: { select: { cardplacement: true } } },
    });
    if (!source) throw new ContentsError(messages.CARD_NOT_FOUND, 404);
    if (source.scryfallid === scryfallid && source.variant === variant) {
      return placement;
    }

    // The copy's new home: same collection, condition and language, the
    // chosen printing and finish. Same-identity rows merge, as everywhere.
    const existing = await tx.card.findFirst({
      where: {
        collectionid: source.collectionid,
        scryfallid,
        conditionid: source.conditionid,
        languageid: source.languageid,
        variant,
      },
    });
    const target =
      existing ??
      (await tx.card.create({
        data: {
          collectionid: source.collectionid,
          scryfallid,
          conditionid: source.conditionid,
          languageid: source.languageid,
          variant,
          quantity: 0,
        },
      }));
    if (!existing) {
      await applyFixedPrice(tx, target);
      await applyReferencePrices(tx, { onlyCardIds: [target.id] });
    }

    const highest = await tx.cardplacement.aggregate({
      where: { cardid: target.id },
      _max: { copyindex: true },
    });
    const moved = await tx.cardplacement.update({
      where: { id: placement.id },
      data: { cardid: target.id, copyindex: (highest._max.copyindex ?? 0) + 1 },
    });
    await tx.card.update({
      where: { id: target.id },
      data: { quantity: { increment: 1 } },
    });

    // Shrink the row the copy left; the last copy takes the row with it.
    if (source._count.cardplacement <= 1) {
      await tx.card.delete({ where: { id: source.id } });
    } else {
      await tx.card.update({
        where: { id: source.id },
        data: { quantity: source._count.cardplacement - 1 },
      });
    }

    return moved;
  });
}

// Throw away everything left in a binder's stand-by area.
//
// Called when the customer finishes editing. Cards left here were taken out of
// their pockets and never put back, and a card with no place is exactly what
// this model does not allow — so they leave the collection.
export async function discardStandby(prisma, storageId) {
  const stranded = await prisma.cardplacement.findMany({
    where: { storageid: storageId, ...STANDBY_WHERE, orderlineid: null },
    include: { storage: { select: { type: true } } },
  });

  let removed = 0;
  for (const placement of stranded) {
    await removeCopy(prisma, placement);
    removed++;
  }
  return removed;
}

// Add one copy of a printing to a container, creating the card row if this
// grade of it did not exist yet.
//
// Creating the card and placing the copy are one action, not two calls, so
// there is no instant where a card exists with nowhere to be. Always exactly
// one copy: wanting three is three calls (or duplicates), which is also how
// the stand-by area works.
//
// Where it lands depends on the container, because "somewhere sensible" means
// something different in each:
//
//   binder      -> the stand-by area, to be dragged into a pocket
//   sorted_box  -> the front, since a new card is the one you are holding
//   unsorted_box-> nowhere in particular; the view is alphabetical
//
// Shared by the customer (their containers, their collection) and the shop
// (its furniture, the staff member's collection). The caller has already
// validated the printing, the finish and who may touch the container.
export async function addPrintingCopy(
  prisma,
  unit,
  collectionid,
  // `sortedEnd` sends a sorted box's copy to the BACK instead of the front —
  // an import reads a file in order, so appending is what keeps that order.
  { scryfallid, conditionid, languageid, variant, sortedEnd = false }
) {
  return prisma.$transaction(async (tx) => {
    // Same printing, grade, language and finish is the same card row with
    // another copy — not a second row saying the same thing.
    const existing = await tx.card.findFirst({
      where: {
        collectionid,
        scryfallid,
        conditionid,
        languageid,
        variant,
      },
      include: { _count: { select: { cardplacement: true } } },
    });

    const card = existing
      ? await tx.card.update({
          where: { id: existing.id },
          data: { quantity: existing._count.cardplacement + 1 },
        })
      : await tx.card.create({
          data: {
            collectionid,
            scryfallid,
            conditionid,
            languageid,
            variant,
            quantity: 1,
          },
        });

    // Price the row the moment it exists, not at the next nightly run: a
    // pinned printing gets its fixed price, everything else the stored
    // CardKingdom reference.
    if (!existing) {
      await applyFixedPrice(tx, card);
      await applyReferencePrices(tx, { onlyCardIds: [card.id] });
    }

    const highest = await tx.cardplacement.aggregate({
      where: { cardid: card.id },
      _max: { copyindex: true },
    });

    const data = {
      cardid: card.id,
      copyindex: (highest._max.copyindex ?? 0) + 1,
      storageid: unit.id,
    };

    if (unit.type === "sorted_box") {
      if (sortedEnd) {
        // To the back, behind everything already filed.
        const last = await tx.cardplacement.aggregate({
          where: { storageid: unit.id },
          _max: { sequence: true },
        });
        data.sequence = (last._max.sequence ?? 0) + 1;
      } else {
        // To the front, and everything else shifts back — a hand-added card
        // is the one you are holding.
        await tx.cardplacement.updateMany({
          where: { storageid: unit.id },
          data: { sequence: { increment: 1 } },
        });
        data.sequence = 1;
      }
    }
    // A binder gets STANDBY_WHERE by omission — page and pocket stay null,
    // which IS the stand-by area. An unsorted box has no positions at all.

    return tx.cardplacement.create({ data });
  });
}

// Bring `card.quantity` back in line with the placements that exist.
//
// Used after a bulk change, and by the check the sync runs — the two numbers
// being equal is the invariant this whole module exists to hold.
export async function reconcileQuantity(prisma, cardId) {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    include: { _count: { select: { cardplacement: true } } },
  });
  if (!card) return null;
  if (card._count.cardplacement === 0) {
    await prisma.card.delete({ where: { id: card.id } });
    return 0;
  }
  if (card.quantity !== card._count.cardplacement) {
    await prisma.card.update({
      where: { id: card.id },
      data: { quantity: card._count.cardplacement },
    });
  }
  return card._count.cardplacement;
}

// Move every copy in a container into a different collection, keeping each
// copy exactly where it physically sits (same pocket/sequence) but changing
// WHOSE it is.
//
// Used when the shop reassigns a container's owner: the container and the cards
// inside it must agree on who they belong to, because `collection.percent` is
// what decides the payout when a card sells. Each copy leaves its current card
// row and joins (or creates) the matching row — same printing, finish, grade,
// language — in the target collection; a freshly created row is priced on the
// spot, the same as any other birth. Copies already sitting in a pick-up bag
// are refused by the caller, so nothing moves out from under an open order.
//
// One transaction for the whole container: reassigning half of it would leave
// the container's cards split between two owners, which is exactly the
// incoherence this exists to prevent.
export async function reassignStorageCollection(
  prisma,
  storageId,
  targetCollectionId,
  newPlayerId
) {
  return prisma.$transaction(async (tx) => {
    const placements = await tx.cardplacement.findMany({
      where: { storageid: storageId, orderlineid: null },
      include: { card: true },
    });

    let moved = 0;
    for (const placement of placements) {
      const source = placement.card;
      if (!source || source.collectionid === targetCollectionId) continue;

      // The copy's new home: same printing/grade/language/finish, the target
      // collection. Same-identity rows merge, as everywhere in this module.
      const existing = await tx.card.findFirst({
        where: {
          collectionid: targetCollectionId,
          scryfallid: source.scryfallid,
          conditionid: source.conditionid,
          languageid: source.languageid,
          variant: source.variant,
        },
      });
      const target =
        existing ??
        (await tx.card.create({
          data: {
            collectionid: targetCollectionId,
            scryfallid: source.scryfallid,
            conditionid: source.conditionid,
            languageid: source.languageid,
            variant: source.variant,
            quantity: 0,
          },
        }));
      if (!existing) {
        await applyFixedPrice(tx, target);
        await applyReferencePrices(tx, { onlyCardIds: [target.id] });
      }

      const highest = await tx.cardplacement.aggregate({
        where: { cardid: target.id },
        _max: { copyindex: true },
      });
      await tx.cardplacement.update({
        where: { id: placement.id },
        data: { cardid: target.id, copyindex: (highest._max.copyindex ?? 0) + 1 },
      });
      await tx.card.update({
        where: { id: target.id },
        data: { quantity: { increment: 1 } },
      });

      // Shrink the row the copy left; the last copy takes the row with it.
      const remaining = await tx.cardplacement.count({
        where: { cardid: source.id },
      });
      if (remaining <= 0) {
        await tx.card.delete({ where: { id: source.id } });
      } else {
        await tx.card.update({
          where: { id: source.id },
          data: { quantity: remaining },
        });
      }
      moved++;
    }

    // Flip the container's owner in the SAME transaction, so the cards and the
    // container can never disagree about who they belong to. `undefined` leaves
    // it untouched (caller only wanted a re-home); `null` means the shop.
    if (newPlayerId !== undefined) {
      await tx.storage.update({
        where: { id: storageId },
        data: { playerid: newPlayerId },
      });
    }
    return moved;
  });
}
