// How many copies of a card can actually be sold right now.
//
// One place, deliberately. This used to be two independent subtractions applied
// by whichever route remembered them, and the storage one was never applied at
// all — a card sitting in a binder the customer had taken home still showed as
// fully available. Every caller now goes through here.
//
// available = quantity
//           − copies held by open reservations
//           − copies filed in a container that is not for sale

// Copies spoken for by pending orders, keyed by card id.
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

// Copies filed in a container that is not for sale: retired, released or on its
// way back. Retiring takes cards off sale immediately, before the container has
// physically moved.
//
// Placements attached to an order line are EXCLUDED: a copy in a pick-up bag is
// already counted as reserved, and counting it here as well would subtract it
// twice.
export async function offSaleByCard(prisma, cardIds) {
  const where = {
    orderlineid: null,
    storage: { state: { not: "for_sale" } },
  };
  if (cardIds) where.cardid = { in: cardIds };

  const rows = await prisma.cardplacement.groupBy({
    by: ["cardid"],
    where,
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.cardid, r._count._all]));
}

// Both subtractions for a set of cards, in one call so a caller cannot apply
// one and forget the other.
export async function availabilityFor(prisma, cards) {
  const ids = cards.map((c) => c.id);
  const [reserved, offSale] = await Promise.all([
    reservedByCard(prisma, ids),
    offSaleByCard(prisma, ids),
  ]);
  return { reserved, offSale };
}

export function availableOf(card, reserved, offSale) {
  return Math.max(
    0,
    card.quantity - (reserved?.get(card.id) ?? 0) - (offSale?.get(card.id) ?? 0)
  );
}
