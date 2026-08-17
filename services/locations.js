// Describing where a physical card is, in the terms each container supports.
//
// Shared by the wishlist-match queue (so the shop can go and fetch the card)
// and by pick-up bags (so a cancelled order can be refiled where it came from).
// Both need the same answer, and it must not drift between them.

// Everything needed to render a location, plus the raw coordinates so a UI can
// link through to the binder page.
export function describeLocation(placement) {
  const storage = placement.storage;
  return {
    placementid: placement.id,
    copyindex: placement.copyindex,
    storageid: storage?.id ?? null,
    storagename: storage?.name ?? null,
    storagetype: storage?.type ?? null,
    state: storage?.state ?? "for_sale",
    owner: storage?.player?.name ?? null,
    page: placement.page,
    pocket: placement.pocket,
    depth: placement.depth,
    sequence: placement.sequence,
    // Set while the copy is in a customer's bag rather than in the container.
    bagged: placement.orderlineid !== null && placement.orderlineid !== undefined,
  };
}

// The include a query needs for describeLocation to have everything.
export const LOCATION_INCLUDE = {
  storage: {
    select: {
      id: true,
      name: true,
      type: true,
      state: true,
      player: { select: { name: true } },
    },
  },
};

// Binder placements first, then sorted boxes, then unsorted — roughly how
// quickly someone can actually lay hands on the card.
const TYPE_ORDER = { binder: 0, sorted_box: 1, unsorted_box: 2 };

export function sortLocations(locations) {
  return locations.slice().sort((a, b) => {
    const byType =
      (TYPE_ORDER[a.storagetype] ?? 9) - (TYPE_ORDER[b.storagetype] ?? 9);
    if (byType) return byType;
    return (
      (a.storagename ?? "").localeCompare(b.storagename ?? "") ||
      (a.page ?? 0) - (b.page ?? 0) ||
      (a.pocket ?? 0) - (b.pocket ?? 0) ||
      (a.sequence ?? 0) - (b.sequence ?? 0)
    );
  });
}
