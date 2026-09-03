// Reservation bookkeeping shared by the store, the customer's order screens and
// the shop's queue.
//
// Reserved stock is never subtracted from `card.quantity`. A reservation is a
// claim, not a sale: decrementing would make a held card indistinguishable from
// a sold one and would need unwinding on every cancel or expiry. Availability
// is therefore always `quantity - (open reservations)`, computed on read.

// How long a pending order holds stock before releasing itself.
//
// UNSET MEANS NEVER EXPIRE. The machinery stays in place — set
// RESERVATION_DAYS to a positive number and holds start timing out again — but
// the default is for a reservation to sit until someone acts on it.
const configured = Number(process.env.RESERVATION_DAYS);
export const RESERVATION_DAYS =
  Number.isFinite(configured) && configured > 0 ? configured : null;

export const nowSeconds = () => Math.round(Date.now() / 1000);

// null expiry = this order never times out.
export const expiryFromNow = () =>
  RESERVATION_DAYS === null ? null : nowSeconds() + RESERVATION_DAYS * 86400;

// Flip pending orders whose deadline has passed.
//
// Called at the start of anything that reads availability rather than run by a
// scheduler: an expired order must not hold stock even for the seconds before a
// cron would notice, and there is nowhere reliable to run a scheduler anyway
// (an in-process timer would fire once per dyno).
export async function releaseExpiredOrders(prisma) {
  // Anything the shop set aside for an order that has now lapsed goes back on
  // the shelf, so it stops being invisible in its container.
  const lapsing = await prisma.order.findMany({
    where: { status: "pending", expires: { not: null, lt: nowSeconds() } },
    select: { id: true },
  });
  if (lapsing.length) {
    // Only copies somebody physically took out need putting back; one that
    // was reserved but never pulled never left its pocket.
    await prisma.cardplacement.updateMany({
      where: {
        orderline: { orderid: { in: lapsing.map((o) => o.id) } },
        pulled: true,
      },
      // Flagged for the home page's refile panel: the copies are physically in
      // a lapsed bag on the counter until somebody puts them back.
      data: { needsrefile: true },
    });
    await prisma.cardplacement.updateMany({
      where: { orderline: { orderid: { in: lapsing.map((o) => o.id) } } },
      data: { orderlineid: null, pulled: false },
    });
  }

  // Orders stored with a null expiry are excluded by this filter, so they are
  // untouched whether or not RESERVATION_DAYS is set now. Turning expiry on
  // later only affects orders placed from that point.
  const { count } = await prisma.order.updateMany({
    where: { status: "pending", expires: { not: null, lt: nowSeconds() } },
    data: { status: "expired", closed: nowSeconds() },
  });
  return count;
}

// Availability now lives in services/availability.js, because it depends on
// storage state as well as reservations and the two must never be applied
// separately. Re-exported so existing importers keep working.
export {
  reservedByCard,
  offSaleByCard,
  availabilityFor,
  availableOf,
} from "./availability.js";

import { storeDisplayName } from "./locations.js";
import { exchangeRate, toPesos } from "./exchange.js";

// Reserve copies of a card into a customer's pick-up bag — the direct-purchase
// path a confirmed cart takes, independent of the wishlist. Finds (or opens)
// the customer's one pending order, grows the card's line by `count`, and
// claims that many free for-sale copies onto the line as NOT-yet-pulled
// (`pulled: false`): the stock is held at once and the copies leave their
// pockets, but the shop still has to physically fetch them — the "Pedidos para
// preparar" queue is what sends someone to do it, flipping each to pulled.
//
// Price is frozen now (a later reprice cannot change what was quoted), the peso
// side at today's rate. `rate` is passed so a whole cart freezes at one rate.
export async function reserveIntoBag(tx, playerId, card, count, rate, wishlistid = null) {
  let bag = await tx.order.findFirst({
    where: { playerid: playerId, status: "pending" },
    orderBy: { created: "asc" },
  });
  if (!bag) {
    bag = await tx.order.create({
      data: {
        playerid: playerId,
        status: "pending",
        created: nowSeconds(),
        expires: expiryFromNow(),
      },
    });
  }

  const price = card.price ?? 0;
  const pricepesos = toPesos(Number(price), rate);
  const baseprice = card.baseprice ?? null;

  const existing = await tx.orderline.findFirst({
    where: { orderid: bag.id, cardid: card.id },
  });
  let lineId;
  if (existing) {
    await tx.orderline.update({
      where: { id: existing.id },
      data: {
        quantity: existing.quantity + count,
        // Keep the wishlist link if this reservation carries one and the line
        // does not already have one.
        ...(wishlistid && existing.wishlistid == null ? { wishlistid } : {}),
      },
    });
    lineId = existing.id;
  } else {
    const created = await tx.orderline.create({
      data: {
        orderid: bag.id,
        cardid: card.id,
        quantity: count,
        price,
        pricepesos,
        baseprice,
        kind: "purchase",
        wishlistid,
      },
    });
    lineId = created.id;
  }

  // Claim `count` specific free copies onto the line, nearest-to-hand first, so
  // the prepare queue can show exactly where each one is. They keep their
  // placement (so a cancel refiles them) and are excluded from pocket views.
  const free = await tx.cardplacement.findMany({
    where: {
      cardid: card.id,
      orderlineid: null,
      storage: { state: "for_sale" },
    },
    orderBy: [
      { page: "asc" },
      { pocket: "asc" },
      { sequence: "asc" },
      { id: "asc" },
    ],
    take: count,
  });
  for (const pl of free) {
    await tx.cardplacement.update({
      where: { id: pl.id },
      data: { orderlineid: lineId, pulled: false },
    });
  }
  return bag;
}

// Whether a pending order is still being assembled: any copy claimed onto it
// has not been physically pulled yet. Expects the order's lines with their
// cardplacements' `pulled` selected.
export function orderIsPreparing(order) {
  return (order.orderline ?? []).some((line) =>
    (line.cardplacement ?? []).some((pl) => pl.pulled === false)
  );
}

// The card's display identity, to freeze onto an order line at completion so a
// completed order still shows its cards after the stock row (`card`) is deleted
// — a card whose last copy leaves the shop is removed, which used to erase the
// line (ON DELETE CASCADE) and now would blank its name/set. Expects a card
// loaded with its cardgeneral.
export function cardSnapshot(card) {
  return {
    cardname: card?.cardgeneral?.name ?? null,
    cardsetcode: card?.cardgeneral?.cardsetcode ?? null,
    cardsetname: card?.cardgeneral?.cardsetname ?? null,
    cardimage: card?.cardgeneral?.image ?? null,
    variant: card?.variant ?? null,
  };
}

// What a line shows: its frozen snapshot when it has one (a completed order,
// whose card may be gone), else the live card (a pending order, or an old
// completed line predating the snapshot, while its card still exists).
export function lineDisplay(line) {
  return {
    name: line.cardname ?? line.card?.cardgeneral?.name ?? null,
    cardsetcode: line.cardsetcode ?? line.card?.cardgeneral?.cardsetcode ?? null,
    cardsetname: line.cardsetname ?? line.card?.cardgeneral?.cardsetname ?? null,
    image: line.cardimage ?? line.card?.cardgeneral?.image ?? null,
    variant: line.variant ?? line.card?.variant ?? null,
  };
}

// Freeze every line's card identity for an order leaving pending (completed or
// cancelled), so the lines keep their name/set after their cards are later
// deleted. The completion route does this inline (it already has the cards
// loaded); the cancel paths call this.
export async function snapshotOrderLines(tx, orderId) {
  const lines = await tx.orderline.findMany({
    where: { orderid: orderId },
    include: {
      card: {
        include: {
          cardgeneral: {
            select: {
              name: true,
              cardsetcode: true,
              cardsetname: true,
              image: true,
            },
          },
        },
      },
    },
  });
  for (const line of lines) {
    await tx.orderline.update({
      where: { id: line.id },
      data: cardSnapshot(line.card),
    });
  }
}

// Put a cancelled or expired order's cards back where they came from.
//
// Placements are retained while a copy sits in a bag precisely so this can
// work: clearing the link puts the card back in its pocket or box slot, which
// is also the answer to "where does this go?".
export async function refileOrder(tx, orderId) {
  const { count } = await tx.cardplacement.updateMany({
    where: { orderline: { orderid: orderId } },
    data: { orderlineid: null, pulled: false },
  });
  return count;
}

// Where each card in an order belongs, for the shop to put them back. Only
// PULLED copies: one that was reserved but never taken out is still sitting
// exactly where its coordinates say, and listing it would send somebody to
// re-file a card that never moved.
export async function refileInstructions(prisma, orderId) {
  const placements = await prisma.cardplacement.findMany({
    where: { orderline: { orderid: orderId }, pulled: true },
    include: {
      storage: {
        select: {
          id: true,
          name: true,
          storename: true,
          type: true,
          player: { select: { name: true } },
        },
      },
      card: { include: { cardgeneral: { select: { name: true, cardsetcode: true } } } },
    },
  });
  return placements.map((pl) => ({
    placementid: pl.id,
    cardid: pl.cardid,
    name: pl.card?.cardgeneral?.name ?? null,
    cardsetcode: pl.card?.cardgeneral?.cardsetcode ?? null,
    storageid: pl.storage?.id ?? null,
    // Read by the shop's refile panel, so the store's label + owner.
    storagename: storeDisplayName(pl.storage),
    storagetype: pl.storage?.type ?? null,
    page: pl.page,
    pocket: pl.pocket,
    depth: pl.depth,
    sequence: pl.sequence,
  }));
}
