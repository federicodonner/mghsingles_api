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

// Sell prices land on 5-cent steps, rounded UP: $4.12 sells at $4.15. Buy
// prices stay at plain cents — rounding what the shop PAYS upward would be a
// policy nobody asked for.
function toNickel(value) {
  // decimal.js calls it ROUND_CEIL — an unknown constant here would silently
  // fall back to nearest, which rounds $4.12 DOWN to $4.10.
  return new Prisma.Decimal(value)
    .mul(20)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_CEIL)
    .div(20)
    .toDecimalPlaces(2);
}

// What a card with no reference price sells for, by rarity. CardKingdom
// simply has no listing for much of the long tail, and "no price" at the
// counter means the card cannot be rung up at all.
const DEFAULT_SELL = { common: "0.35", uncommon: "0.50" };

const ONE_DOLLAR = new Prisma.Decimal(1);

// Cheap rares and mythics sell at a $1 minimum. The consignor is paid their
// share of the ACTUAL selling price ($1), like any other card, so there is no
// separate commission base to record — `baseprice` stays null. (Until
// 2026-09-02 the consignor was paid on the card's real sub-$1 price and the $1
// uplift was the store's; sales made before then still carry that baseprice
// and keep their original basis.)
const FLOORED_RARITIES = new Set(["rare", "mythic"]);

function sellPricesFor(derived, rarity) {
  if (FLOORED_RARITIES.has(rarity) && derived.lt(ONE_DOLLAR)) {
    return { price: ONE_DOLLAR, baseprice: null };
  }
  return { price: derived, baseprice: null };
}

// The same $1 floor for a HAND-SET price: a rare or mythic pinned below $1
// still sells at $1. The consignor is paid on that actual $1 (no separate
// commission base — baseprice null), exactly as for a CardKingdom-derived
// floor. Exported so every place that stamps a fixed price onto a card obeys
// the floor.
export function pinnedSell(pinPrice, rarity) {
  return sellPricesFor(new Prisma.Decimal(pinPrice), rarity);
}

// Decimal-or-null equality, for deciding whether a row actually changed.
function sameMoney(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return new Prisma.Decimal(a).equals(b);
}

// Stamp a printing's pinned price onto one stock row, if the printing has one.
//
// Called where card rows are BORN (adding to a collection, adding a copy to a
// container), so a version fixed while out of stock prices its first arriving
// copy immediately rather than at the next nightly run. Works inside a
// transaction or on a plain client. Returns the update, or null when the
// printing has no pin.
export async function applyFixedPrice(db, card) {
  if (!card?.scryfallid) return null;
  const pin = await db.fixedprice.findUnique({
    where: { scryfallid: card.scryfallid },
    include: { cardgeneral: { select: { rarity: true } } },
  });
  if (!pin) return null;

  const now = Math.round(Date.now() / 1000);
  const data = {};
  if (pin.price !== null) {
    // A hand-set price obeys the $1 floor too: a rare/mythic pinned below $1
    // sells at $1 with the pin as the commission base.
    const { price, baseprice } = pinnedSell(pin.price, pin.cardgeneral?.rarity ?? null);
    data.price = price;
    data.baseprice = baseprice;
    // A SOFT pin leaves the row UNLOCKED so the nightly sync can hand it over
    // to CardKingdom once a reference appears; a hard pin locks it.
    data.pricelocked = !pin.revert;
    data.priceupdate = now;
  }
  if (pin.buyprice !== null) {
    data.buyprice = pin.buyprice;
    data.buypricelocked = true;
    data.buypriceupdate = now;
  }
  if (!Object.keys(data).length) return null;
  return db.card.update({ where: { id: card.id }, data });
}

// The shop's would-be SELL price for each of a list of printings — what a
// copy will cost once it is on the shelf, whether or not one exists today.
// Same rules as applyReferencePrices: a pin wins outright; otherwise the NM
// reference on a 5-cent step, rarity defaults for the unlisted long tail,
// and the $1 floor on cheap rares and mythics. Used by browsing surfaces
// (the wishlist's version picker) that quote printings, not stock rows.
//
// `printings` need scryfallid, rarity and finishes; the price quoted is for
// the printing's FIRST finish, which is nonfoil whenever nonfoil exists.
// Returns a Map scryfallid -> Decimal price (or null when unpriceable).
export async function quotePrintings(prisma, printings) {
  const ids = [
    ...new Set(printings.map((p) => p.scryfallid).filter(Boolean)),
  ];
  if (!ids.length) return new Map();

  const [nm, references, pins] = await Promise.all([
    prisma.cardcondition.findFirst({
      where: { name: "NM" },
      select: { sellmultiplier: true },
    }),
    prisma.cardprice.findMany({
      where: { source: SOURCE, scryfallid: { in: ids } },
      select: { scryfallid: true, finish: true, retail: true },
    }),
    prisma.fixedprice.findMany({ where: { scryfallid: { in: ids } } }),
  ]);
  const sellMultiplier = nm?.sellmultiplier ?? new Prisma.Decimal(1);
  const referenceFor = new Map(
    references.map((r) => [`${r.scryfallid}:${r.finish}`, r])
  );
  const pinFor = new Map(pins.map((p) => [p.scryfallid, p]));

  const quotes = new Map();
  for (const printing of printings) {
    const finish = (printing.finishes ?? [])[0] ?? "nonfoil";
    const reference = referenceFor.get(`${printing.scryfallid}:${finish}`);
    const pin = pinFor.get(printing.scryfallid);
    const rarity = printing.rarity ?? null;
    // A hard pin wins outright; a soft pin (revert) only while CardKingdom has
    // no reference — once it does, the quote follows the market. Either way the
    // $1 floor applies to a cheap rare/mythic.
    if (pin?.price != null && (!pin.revert || reference?.retail == null)) {
      quotes.set(printing.scryfallid, pinnedSell(pin.price, rarity).price);
      continue;
    }
    const derived =
      reference?.retail != null
        ? toNickel(reference.retail.mul(sellMultiplier))
        : DEFAULT_SELL[rarity]
          ? new Prisma.Decimal(DEFAULT_SELL[rarity])
          : null;
    quotes.set(
      printing.scryfallid,
      derived === null ? null : sellPricesFor(derived, rarity).price
    );
  }
  return quotes;
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
      baseprice: true,
      buyprice: true,
      pricelocked: true,
      buypricelocked: true,
      cardgeneral: { select: { rarity: true } },
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

  // Every card prices as if near-mint (2026-08-23): the shop stopped showing
  // condition, so a played copy must not undercut the NM price it is listed
  // at. The rows still RECORD their real grade — only pricing ignores it.
  const nm = await prisma.cardcondition.findFirst({
    where: { name: "NM" },
    select: { sellmultiplier: true, buymultiplier: true },
  });
  const sellMultiplier = nm?.sellmultiplier ?? new Prisma.Decimal(1);
  const buyMultiplier = nm?.buymultiplier ?? new Prisma.Decimal(1);

  const now = Math.round(Date.now() / 1000);
  let sell = 0;
  let buy = 0;
  let locked = 0;
  let noReference = 0;
  const updates = [];

  for (const card of cards) {
    // No `continue` on a missing reference: a common or uncommon the source
    // has never listed still gets its default sell price below.
    const reference =
      referenceFor.get(`${card.scryfallid}:${card.variant}`) ?? null;
    if (!reference) noReference++;

    const data = {};
    const rarity = card.cardgeneral?.rarity ?? null;

    // Rule 1 and 3: each side is considered on its own, and a locked side is
    // skipped without affecting the other.
    if (card.pricelocked) {
      locked++;
    } else {
      // The market-derived price, on a 5-cent step. When the source has
      // nothing (rule 2: never CLEAR a price), a card that has no price at
      // all still gets the rarity default — 35c commons, 50c uncommons —
      // because "no price" means it cannot be rung up.
      const derived =
        reference?.retail != null
          ? toNickel(reference.retail.mul(sellMultiplier))
          : card.price == null && DEFAULT_SELL[rarity]
            ? new Prisma.Decimal(DEFAULT_SELL[rarity])
            : null;
      if (derived !== null) {
        const next = sellPricesFor(derived, rarity);
        if (
          !sameMoney(card.price, next.price) ||
          !sameMoney(card.baseprice, next.baseprice)
        ) {
          data.price = next.price;
          data.baseprice = next.baseprice;
          data.priceupdate = now;
          sell++;
        }
      }
    }

    if (card.buypricelocked) {
      // Counted once per card, not once per side, so the number reads as
      // "cards the shop has pinned".
      if (!card.pricelocked) locked++;
    } else if (reference && reference.buylist !== null) {
      const next = toCents(reference.buylist.mul(buyMultiplier));
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

  // Re-stamp the printing-level pins. Creation paths already stamp new rows,
  // but a row that slipped in through any other door (a bulk import, a manual
  // fix) picks the pin up here — the fixedprice table is authoritative until
  // the pin is deleted, so an unlocked row of a pinned printing is a row that
  // has drifted, not a choice to respect.
  let pinned = 0;
  const pins = await prisma.fixedprice.findMany({
    where: onlyCardIds
      ? {
          scryfallid: {
            in: [...new Set(cards.map((c) => c.scryfallid).filter(Boolean))],
          },
        }
      : {},
    include: { cardgeneral: { select: { rarity: true } } },
  });
  for (const pin of pins) {
    const rowScope = onlyCardIds ? { id: { in: onlyCardIds } } : {};
    // The pin obeys the $1 floor: a cheap rare/mythic sells at $1 with the pin
    // as the commission base. One rarity per printing, so one result per pin.
    const { price: pinPrice, baseprice: pinBase } = pinnedSell(
      pin.price ?? 0,
      pin.cardgeneral?.rarity ?? null
    );
    if (pin.price !== null && pin.revert) {
      // SOFT pin: only a fallback for rows CardKingdom has not priced. The main
      // loop above already set the CardKingdom price on any unlocked row that
      // has a reference (so those rows now have a non-null price and are
      // skipped here); this fills the still-unpriced rows with the pin price
      // and leaves them UNLOCKED, so the day CardKingdom lists the card the
      // main loop replaces it. Never locks, never overrides a real price.
      const { count } = await prisma.card.updateMany({
        where: {
          ...rowScope,
          scryfallid: pin.scryfallid,
          pricelocked: false,
          price: null,
        },
        data: { price: pinPrice, baseprice: pinBase, priceupdate: now },
      });
      pinned += count;
    } else if (pin.price !== null) {
      // HARD pin: authoritative. Stamp onto every unlocked row and lock it.
      const { count } = await prisma.card.updateMany({
        where: { ...rowScope, scryfallid: pin.scryfallid, pricelocked: false },
        data: {
          price: pinPrice,
          baseprice: pinBase,
          pricelocked: true,
          priceupdate: now,
        },
      });
      pinned += count;
    }
    if (pin.buyprice !== null) {
      const { count } = await prisma.card.updateMany({
        where: { ...rowScope, scryfallid: pin.scryfallid, buypricelocked: false },
        data: { buyprice: pin.buyprice, buypricelocked: true, buypriceupdate: now },
      });
      pinned += count;
    }
  }

  log(
    `pricing: ${cards.length} card(s) considered, ${sell} sell and ${buy} buy ` +
      `price(s) updated, ${locked} locked, ${noReference} with no reference` +
      (pinned ? `, ${pinned} re-pinned to a fixed price` : "")
  );
  return { considered: cards.length, sell, buy, locked, noReference, pinned };
}

export default applyReferencePrices;
