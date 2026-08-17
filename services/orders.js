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
    await prisma.cardplacement.updateMany({
      where: { orderline: { orderid: { in: lapsing.map((o) => o.id) } } },
      data: { orderlineid: null },
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

// How many copies of each card id are spoken for by open reservations.
// Returns a Map of cardid -> reserved quantity.
export async function reservedByCard(prisma, cardIds) {
  const where = { order: { status: "pending" } };
  if (cardIds) where.cardid = { in: cardIds };

  const rows = await prisma.orderline.groupBy({
    by: ["cardid"],
    where,
    _sum: { quantity: true },
  });
  return new Map(rows.map((r) => [r.cardid, r._sum.quantity ?? 0]));
}

// Available = stock minus whatever is being held for someone.
export function availableOf(card, reserved) {
  return Math.max(0, card.quantity - (reserved.get(card.id) ?? 0));
}

// Put a cancelled or expired order's cards back where they came from.
//
// Placements are retained while a copy sits in a bag precisely so this can
// work: clearing the link puts the card back in its pocket or box slot, which
// is also the answer to "where does this go?".
export async function refileOrder(tx, orderId) {
  const { count } = await tx.cardplacement.updateMany({
    where: { orderline: { orderid: orderId } },
    data: { orderlineid: null },
  });
  return count;
}

// Where each card in an order belongs, for the shop to put them back.
export async function refileInstructions(prisma, orderId) {
  const placements = await prisma.cardplacement.findMany({
    where: { orderline: { orderid: orderId } },
    include: {
      storage: { select: { id: true, name: true, type: true } },
      card: { include: { cardgeneral: { select: { name: true, cardsetcode: true } } } },
    },
  });
  return placements.map((pl) => ({
    placementid: pl.id,
    cardid: pl.cardid,
    name: pl.card?.cardgeneral?.name ?? null,
    cardsetcode: pl.card?.cardgeneral?.cardsetcode ?? null,
    storageid: pl.storage?.id ?? null,
    storagename: pl.storage?.name ?? null,
    storagetype: pl.storage?.type ?? null,
    page: pl.page,
    pocket: pl.pocket,
    depth: pl.depth,
    sequence: pl.sequence,
  }));
}
