// Putting a matched card into its customer's pick-up bag.
//
// Shared by the two roads that lead here: the shop working through the match
// queue, and a customer buying a card straight off the storefront — where the
// match is created and bagged in the same breath instead of waiting for the
// matcher run. Both must behave identically, because the bag IS the customer's
// open pending order and reserving is what takes the copy out of everyone
// else's availability.
import messages from "../data/messages.js";
import {
  nowSeconds,
  expiryFromNow,
  releaseExpiredOrders,
} from "./orders.js";
import { availabilityFor, availableOf } from "./availability.js";
import { exchangeRate, toPesos } from "./exchange.js";

export class MatchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Merge one constraint list into another, where an EMPTY list means "any" —
// so an existing broader entry stays as broad as it was.
function union(current, incoming) {
  if (!current.length || !incoming.length) return [];
  const seen = new Set(current);
  return [...current, ...incoming.filter((v) => !seen.has(v))];
}

// Create the wishlist entry and match that the next matcher run would have
// raised for this exact copy — printing, grade, language and finish.
//
// Shared by the storefront buy (which bags the copy in the same breath) and a
// customer asking for their own card back out of a container the shop holds
// (which leaves the match for the shop to act on). `bumpWanted` is the second
// ask for the same card: asking again means another copy, so the entry's
// quantity grows instead of the request dissolving into the first one.
export async function raisePinnedMatch(
  prisma,
  playerId,
  card,
  { bumpWanted = false } = {}
) {
  const name = card.cardgeneral.name;
  let entry = await prisma.wishlist.findFirst({
    where: {
      playerid: playerId,
      name: { equals: name, mode: "insensitive" },
    },
  });
  if (entry) {
    entry = await prisma.wishlist.update({
      where: { id: entry.id },
      data: {
        versions: union(entry.versions, [card.scryfallid]),
        languageids: union(entry.languageids, [card.languageid]),
        conditionids: union(entry.conditionids, [card.conditionid]),
        variants: union(entry.variants, [card.variant]),
      },
    });
  } else {
    entry = await prisma.wishlist.create({
      data: {
        playerid: playerId,
        name,
        created: nowSeconds(),
        quantity: 1,
        versions: [card.scryfallid],
        languageids: [card.languageid],
        conditionids: [card.conditionid],
        variants: [card.variant],
      },
    });
  }

  // One may already exist — raised by the matcher, or resolved earlier by a
  // dismissal — so reuse or reopen rather than tripping the
  // (wishlistid, cardid) unique.
  const kind =
    card.collection?.playerid === playerId ? "withdrawal" : "purchase";
  let match = await prisma.wishlistmatch.findFirst({
    where: { wishlistid: entry.id, cardid: card.id },
  });
  if (!match) {
    match = await prisma.wishlistmatch.create({
      data: {
        wishlistid: entry.id,
        cardid: card.id,
        playerid: playerId,
        kind,
        found: nowSeconds(),
      },
    });
  } else if (match.resolved) {
    match = await prisma.wishlistmatch.update({
      where: { id: match.id },
      data: { resolved: null, resolution: null, found: nowSeconds() },
    });
  } else if (bumpWanted) {
    await prisma.wishlist.update({
      where: { id: entry.id },
      data: { quantity: Math.min(entry.quantity + 1, 4) },
    });
  }

  return match;
}

// The includes setAsideMatch needs on a match row; callers that already hold a
// match id can let the service load it.
const MATCH_INCLUDE = {
  card: {
    include: { cardgeneral: { select: { name: true, cardsetcode: true } } },
  },
};

// Put one copy for this match into the customer's bag.
//
// `placementid` optionally names the exact copy the shop pulled; otherwise the
// first copy not already in a bag is taken. `pulled` says whether a person is
// physically holding the card right now: true when the shop works the match
// queue (they just fetched it), false for a storefront buy — the copy is
// reserved instantly but still sits in its pocket, and the home page's pull
// queue is what sends somebody to get it.
export async function setAsideMatch(prisma, matchId, placementid, { pulled = false } = {}) {
  const match = await prisma.wishlistmatch.findUnique({
    where: { id: matchId },
    include: MATCH_INCLUDE,
  });
  if (!match || match.resolved) {
    throw new MatchError(messages.MATCH_NOT_FOUND, 404);
  }

  await releaseExpiredOrders(prisma);

  // Is the card still actually free to give away? Both a reservation and a
  // retired container take it out of reach.
  const { reserved, offSale } = await availabilityFor(prisma, [match.card]);
  const available = availableOf(match.card, reserved, offSale);
  if (available < 1) {
    throw new MatchError(messages.ORDER_NOT_ENOUGH_STOCK);
  }

  await prisma.$transaction(async (tx) => {
    // One open bag per customer; anything already set aside joins it.
    let bag = await tx.order.findFirst({
      where: { playerid: match.playerid, status: "pending" },
      orderBy: { created: "asc" },
    });
    if (!bag) {
      bag = await tx.order.create({
        data: {
          playerid: match.playerid,
          status: "pending",
          created: nowSeconds(),
          expires: expiryFromNow(),
        },
      });
    }

    // A withdrawal is the customer's own card, so it is priced at zero:
    // nothing is owed for taking it home. The peso side is frozen alongside
    // the dollar one, at the exchange rate of the day the copy is bagged.
    const price = match.kind === "withdrawal" ? 0 : match.card?.price ?? 0;
    const pricepesos = toPesos(price, await exchangeRate(tx));
    // The commission base rides along: a floored rare pays its consignor
    // from the real price, frozen with the quote.
    const baseprice =
      match.kind === "withdrawal" ? null : match.card?.baseprice ?? null;

    const line = await tx.orderline.findFirst({
      where: { orderid: bag.id, cardid: match.cardid },
    });
    let lineId;
    if (line) {
      await tx.orderline.update({
        where: { id: line.id },
        data: { quantity: line.quantity + 1 },
      });
      lineId = line.id;
    } else {
      const created = await tx.orderline.create({
        data: {
          orderid: bag.id,
          cardid: match.cardid,
          quantity: 1,
          price,
          pricepesos,
          baseprice,
          kind: match.kind,
        },
      });
      lineId = created.id;
    }

    // The card physically moves into the bag, but its placement is KEPT and
    // attached to the line instead of being deleted: it is the only record
    // of where the copy belongs, and a cancelled order has to be refiled.
    // Views of container contents exclude bagged placements, so the card
    // still stops showing as being in the pocket.
    const wanted = placementid
      ? await tx.cardplacement.findFirst({
          where: {
            id: parseInt(placementid, 10),
            cardid: match.cardid,
            orderlineid: null,
          },
        })
      : await tx.cardplacement.findFirst({
          where: {
            cardid: match.cardid,
            orderlineid: null,
            // A withdrawal comes out of the customer's OWN container, never
            // the shop's display — an identical copy there is for sale, not
            // theirs to take home.
            ...(match.kind === "withdrawal"
              ? { storage: { playerid: match.playerid } }
              : {}),
          },
          orderBy: [
            { page: "asc" },
            { pocket: "asc" },
            { sequence: "asc" },
            { id: "asc" },
          ],
        });
    if (wanted) {
      await tx.cardplacement.update({
        where: { id: wanted.id },
        data: { orderlineid: lineId, pulled },
      });
    }

    // The wish is answered only once enough copies are in the bag.
    //
    // Setting one aside used to delete the entry outright, which was right
    // while every wish was for a single copy. A customer wanting three would
    // otherwise lose the entry after the first, and the remaining two would
    // never be looked for again.
    const wish = await tx.wishlist.findUnique({
      where: { id: match.wishlistid },
    });
    const bagged = await tx.orderline.aggregate({
      where: {
        orderid: bag.id,
        card: {
          cardgeneral: { name: { equals: wish.name, mode: "insensitive" } },
        },
      },
      _sum: { quantity: true },
    });
    const answered = (bagged._sum.quantity ?? 0) >= wish.quantity;
    if (answered) {
      await tx.wishlist.delete({ where: { id: match.wishlistid } });
    }

    // Tell the customer, once the wish is complete. Fired here rather than
    // when the match was found: until the card is actually pulled it could
    // still be sold at the counter, and promising it first would be a lie
    // some of the time. Held back until the last copy so somebody wanting
    // three is not told "ready" three times.
    if (answered) await tx.notification.create({
      data: {
        playerid: match.playerid,
        kind:
          match.kind === "withdrawal"
            ? "wishlist_withdrawal_ready"
            : "wishlist_purchase_ready",
        // Snapshotted: the card row disappears once the order completes.
        cardname: match.card?.cardgeneral?.name ?? null,
        cardsetcode: match.card?.cardgeneral?.cardsetcode ?? null,
        variant: match.card?.variant ?? null,
        orderid: bag.id,
        created: nowSeconds(),
      },
    });
  });
}
