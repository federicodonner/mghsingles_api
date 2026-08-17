// Reservation bookkeeping shared by the store, the customer's order screens and
// the shop's queue.
//
// Reserved stock is never subtracted from `card.quantity`. A reservation is a
// claim, not a sale: decrementing would make a held card indistinguishable from
// a sold one and would need unwinding on every cancel or expiry. Availability
// is therefore always `quantity - (open reservations)`, computed on read.

// A pending order holds stock for this long before it releases itself.
export const RESERVATION_DAYS = Number(process.env.RESERVATION_DAYS ?? 7);

export const nowSeconds = () => Math.round(Date.now() / 1000);
export const expiryFromNow = () => nowSeconds() + RESERVATION_DAYS * 86400;

// Flip pending orders whose deadline has passed.
//
// Called at the start of anything that reads availability rather than run by a
// scheduler: an expired order must not hold stock even for the seconds before a
// cron would notice, and there is nowhere reliable to run a scheduler anyway
// (an in-process timer would fire once per dyno).
export async function releaseExpiredOrders(prisma) {
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
