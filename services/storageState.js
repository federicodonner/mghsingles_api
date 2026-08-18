// The lifecycle of a customer's container, and who may move it along.
//
//        ┌──────────┐   customer retires    ┌─────────┐
//        │ for_sale │ ────────────────────► │ retired │
//        │          │ ◄──────────────────── │         │  shop cancels
//        └──────────┘   shop accepts        └─────────┘
//             ▲  │                               │ shop hands it over
//             │  │ shop hands it back            ▼
//             │  └──────────────────────► ┌──────────┐
//        ┌───────────┐  customer brings it │ released │
//        │ returning │ ◄───────────────────│          │
//        └───────────┘                     └──────────┘
//
// Retiring takes the cards off sale IMMEDIATELY, before anything moves
// physically: the customer has said they want it back, so it should stop being
// sold that instant. Releasing is the separate, later fact that the shop
// actually handed it over.
//
// Each step has one actor. The customer says what they want; the shop confirms
// what physically happened. Letting either do both would mean the record
// claiming a binder had changed hands when it was still on the shelf.
export const STATES = ["for_sale", "retired", "released", "returning"];

// Only cards in a for_sale container are sellable. Everything else is either
// spoken for, in transit, or in somebody's living room.
export const SELLABLE_STATE = "for_sale";

// [from, to] pairs each actor may perform.
const CUSTOMER_MOVES = [
  ["for_sale", "retired"], // "I want my binder back"
  ["released", "returning"], // "I am bringing it in"
];
const SHOP_MOVES = [
  // Handing a container back across the counter, without the customer having
  // asked first. The customer is standing there — making them file a request so
  // the shop can approve it would be theatre. It goes straight to `released`,
  // and the cards come off sale on the way, since `retired` and `released` both
  // mean "not for sale" and the container is leaving either way.
  ["for_sale", "released"],
  ["retired", "released"], // handed over the physical container
  ["retired", "for_sale"], // customer changed their mind before collecting
  ["returning", "for_sale"], // took delivery; cards go back on sale
];

export const customerCanMove = (from, to) =>
  CUSTOMER_MOVES.some(([f, t]) => f === from && t === to);
export const shopCanMove = (from, to) =>
  SHOP_MOVES.some(([f, t]) => f === from && t === to);

// A customer may rearrange a container only while it is in their hands.
export const customerCanEdit = (state) => state === "released";

// Copies in this container that are committed to somebody's pick-up bag.
//
// These must not travel with the container when it is released: they are
// promised to a buyer and physically sitting in a bag on the shop's counter.
export async function committedPlacements(prisma, storageId) {
  return prisma.cardplacement.findMany({
    where: { storageid: storageId, orderlineid: { not: null } },
    include: {
      card: { include: { cardgeneral: { select: { name: true } } } },
      orderline: { include: { order: { select: { playerid: true } } } },
    },
  });
}
