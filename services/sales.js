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
export async function recordSale(tx, { card, quantity, price, date }) {
  await tx.sale.create({
    data: {
      collectionid: card.collectionid,
      scryfallid: card.scryfallid,
      // Per unit, matching sale.price elsewhere.
      price,
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

  // Copies are numbered 1..quantity, so shrinking the row leaves any placement
  // above the new count pointing at a copy that no longer exists. Drop those,
  // otherwise a binder keeps showing cards that were sold off the top.
  await tx.cardplacement.deleteMany({
    where: { cardid: card.id, copyindex: { gt: remaining } },
  });
}

export default recordSale;
