import { isFoil } from "./finishes.js";

// Recording a sale, shared by the counter (POST /admin/sale) and by completing
// a customer's reservation (POST /admin/order/:id/complete).
//
// Both must behave identically: a sale row is what the consignor is eventually
// paid from, so an order that skipped this would quietly cheat them.

// Sell `quantity` copies of `card` at `price` each, inside an open transaction.
//
// `card` must have been loaded with its `collection`, since the commission rate
// lives there and is captured onto the sale — repricing a collection later must
// not rewrite what past sales owed.
export async function recordSale(
  tx,
  { card, quantity, price, baseprice = null, date, placementIds }
) {
  await tx.sale.create({
    data: {
      collectionid: card.collectionid,
      scryfallid: card.scryfallid,
      // Per unit, matching sale.price elsewhere.
      price,
      // The real per-unit price the consignor's share is computed from, when
      // `price` was raised by a selling rule (the $1 rare floor). Null means
      // price is also the commission base.
      baseprice,
      percent: card.collection?.percent ?? 0,
      quantity,
      date,
      conditionid: card.conditionid,
      languageid: card.languageid,
      // `card` records a finish; `sale` still carries a plain boolean, so any
      // kind of foil (including etched) counts as foil here.
      foil: isFoil(card.variant),
    },
  });

  if (quantity >= card.quantity) {
    // Every copy is gone, so its placements go with it.
    await tx.cardplacement.deleteMany({ where: { cardid: card.id } });
    await tx.card.delete({ where: { id: card.id } });
    return;
  }

  const remaining = card.quantity - quantity;
  await tx.card.update({
    where: { id: card.id },
    data: { quantity: remaining },
  });

  await dropPlacementsFor(tx, card, remaining, placementIds);
}

// Remove the placements of the copies that physically left.
//
// When the sale came from a pick-up bag we know exactly which copies those
// were, because the bag holds their placements. Deleting by "copyindex above
// the new count" instead would be wrong whenever the copy taken was not the
// highest-numbered one — selling copy 2 of 4 would leave copy 2's pocket
// occupied and wrongly empty copy 4's.
//
// A counter sale has no such record, so fall back to trimming the top.
async function dropPlacementsFor(tx, card, remaining, placementIds) {
  if (placementIds?.length) {
    await tx.cardplacement.deleteMany({ where: { id: { in: placementIds } } });
    return;
  }
  await tx.cardplacement.deleteMany({
    where: { cardid: card.id, copyindex: { gt: remaining } },
  });
}

export default recordSale;

// Take `quantity` copies of `card` out of stock WITHOUT recording a sale.
//
// Used when a customer collects a card from their own consigned collection:
// the card leaves the shop, but there is no buyer, no money and nobody to pay
// out. Writing a sale here would credit the owner for buying their own card.
export async function recordWithdrawal(tx, { card, quantity, placementIds }) {
  if (quantity >= card.quantity) {
    await tx.cardplacement.deleteMany({ where: { cardid: card.id } });
    await tx.card.delete({ where: { id: card.id } });
    return;
  }
  const remaining = card.quantity - quantity;
  await tx.card.update({
    where: { id: card.id },
    data: { quantity: remaining },
  });
  await dropPlacementsFor(tx, card, remaining, placementIds);
}
