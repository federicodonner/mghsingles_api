// Turning CardKingdom reference prices into the shop's own prices.
//
// CardKingdom quotes ONE price per printing and finish, which is the near-mint
// price. Every other grade is that price times the condition's multiplier, so
// the multipliers are the shop's pricing policy and live on `cardcondition`
// where they can be edited.
//
// Three rules govern whether a card is repriced at all:
//
//   1. A locked price is never touched. `pricelocked` and `buypricelocked` are
//      what a human sets when a card is deliberately priced off-market.
//   2. A reference the source does not have never clears an existing price.
//      CardKingdom drops cards it has no stock of, and a card silently falling
//      to null would read as free.
//   3. Sell and buy are independent. CardKingdom often has a buylist and no
//      retail for the same card, so one side updating must not depend on the
//      other.
import { Prisma } from "@prisma/client";

const SOURCE = "cardkingdom";

// Round to cents. Prisma's Decimal keeps the arithmetic exact; this only
// decides the presentation, and money in this system is 2dp everywhere else.
function toCents(value) {
  return value === null || value === undefined
    ? null
    : new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

// Recompute stock prices from the stored references.
//
// `onlyCardIds` limits the work to specific rows, which is what the
// single-card recalculation in the admin UI uses.
export async function applyReferencePrices(
  prisma,
  { log = () => {}, onlyCardIds = null } = {}
) {
  const where = onlyCardIds ? { id: { in: onlyCardIds } } : {};
  const cards = await prisma.card.findMany({
    where,
    select: {
      id: true,
      scryfallid: true,
      variant: true,
      price: true,
      buyprice: true,
      pricelocked: true,
      buypricelocked: true,
      cardcondition: {
        select: { sellmultiplier: true, buymultiplier: true },
      },
    },
  });
  if (!cards.length) return { considered: 0, sell: 0, buy: 0, locked: 0, noReference: 0 };

  const references = await prisma.cardprice.findMany({
    where: {
      source: SOURCE,
      scryfallid: { in: [...new Set(cards.map((c) => c.scryfallid).filter(Boolean))] },
    },
    select: { scryfallid: true, finish: true, retail: true, buylist: true },
  });
  const referenceFor = new Map(
    references.map((r) => [`${r.scryfallid}:${r.finish}`, r])
  );

  const now = Math.round(Date.now() / 1000);
  let sell = 0;
  let buy = 0;
  let locked = 0;
  let noReference = 0;
  const updates = [];

  for (const card of cards) {
    const reference = referenceFor.get(`${card.scryfallid}:${card.variant}`);
    if (!reference) {
      noReference++;
      continue;
    }

    const data = {};

    // Rule 1 and 3: each side is considered on its own, and a locked side is
    // skipped without affecting the other.
    if (card.pricelocked) {
      locked++;
    } else if (reference.retail !== null) {
      const next = toCents(
        reference.retail.mul(card.cardcondition.sellmultiplier)
      );
      // Rule 2 is implicit here: a null retail simply never reaches this
      // branch, so whatever the card already had survives.
      if (!card.price || !next.equals(card.price)) {
        data.price = next;
        data.priceupdate = now;
        sell++;
      }
    }

    if (card.buypricelocked) {
      // Counted once per card, not once per side, so the number reads as
      // "cards the shop has pinned".
      if (!card.pricelocked) locked++;
    } else if (reference.buylist !== null) {
      const next = toCents(
        reference.buylist.mul(card.cardcondition.buymultiplier)
      );
      if (!card.buyprice || !next.equals(card.buyprice)) {
        data.buyprice = next;
        data.buypriceupdate = now;
        buy++;
      }
    }

    if (Object.keys(data).length) updates.push({ id: card.id, data });
  }

  // Stock is small next to the catalogue — a shop holds thousands of rows, not
  // hundreds of thousands — so individual updates are fine and keep the
  // per-card logic readable.
  for (const update of updates) {
    await prisma.card.update({ where: { id: update.id }, data: update.data });
  }

  log(
    `pricing: ${cards.length} card(s) considered, ${sell} sell and ${buy} buy ` +
      `price(s) updated, ${locked} locked, ${noReference} with no reference`
  );
  return { considered: cards.length, sell, buy, locked, noReference };
}

export default applyReferencePrices;
