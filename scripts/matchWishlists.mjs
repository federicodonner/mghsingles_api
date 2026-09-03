#!/usr/bin/env node
// Find cards in stock that satisfy somebody's wishlist, so the shop can set
// them aside.
//
//   node -r dotenv/config scripts/matchWishlists.mjs
//   node -r dotenv/config scripts/matchWishlists.mjs --dry-run
//
// Runs on a schedule rather than on every write. Matching is a
// wishlist-by-stock comparison, so hooking it to "card added" or "wishlist
// added" would run it constantly to discover nothing, and would still miss the
// cases that arise from a card being unreserved or a constraint being edited.
//
// Two kinds of match:
//   purchase   - the card belongs to another consignor; the customer buys it
//   withdrawal - the card is in the customer's OWN collection; they can simply
//                take it back, with no payment and nobody to pay out
//
// Resolved matches are left in place as a record. Unresolved ones are recomputed
// every run, so a match disappears by itself if the card sells, the wishlist
// entry is deleted, or the customer narrows their constraints past it.
import { createPrismaClient } from "../services/prisma.js";
import { matches } from "../routes/wishlist.js";
import { releaseExpiredOrders, reserveIntoBag } from "../services/orders.js";
import { availabilityFor, availableOf } from "../services/availability.js";
import { exchangeRate } from "../services/exchange.js";

const prisma = createPrismaClient();
const DRY_RUN = process.argv.includes("--dry-run");
const now = () => Math.round(Date.now() / 1000);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function main() {
  const started = now();

  // Stock held by a dead reservation is not really available, and must not
  // produce a match the shop cannot act on.
  await releaseExpiredOrders(prisma);

  const entries = await prisma.wishlist.findMany({
    include: { player: { select: { id: true, name: true } } },
  });
  if (!entries.length) {
    log("no wishlist entries; nothing to match");
    return { found: 0, cleared: 0, entries: 0 };
  }

  const cards = await prisma.card.findMany({
    where: {
      collection: { active: true },
      cardgeneral: { name: { in: entries.map((e) => e.name), mode: "insensitive" } },
    },
    include: {
      cardgeneral: { select: { name: true } },
      collection: { select: { playerid: true } },
    },
  });

  const { reserved, offSale } = await availabilityFor(prisma, cards);

  const byName = new Map();
  for (const card of cards) {
    const key = (card.cardgeneral?.name ?? "").toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(card);
  }

  // How many copies each auto-buy wish already has reserved on a pending order,
  // so a wish is not bought twice across runs.
  const autobuyIds = entries.filter((e) => e.autobuy).map((e) => e.id);
  const reservedForWish = new Map();
  if (autobuyIds.length) {
    const rows = await prisma.orderline.groupBy({
      by: ["wishlistid"],
      where: { wishlistid: { in: autobuyIds }, order: { is: { status: "pending" } } },
      _sum: { quantity: true },
    });
    for (const r of rows) reservedForWish.set(r.wishlistid, r._sum.quantity ?? 0);
  }

  // Two outcomes for an available card:
  //   - an ordinary MATCH the shop confirms and pulls (wantedMatches), or
  //   - an AUTO-BUY reservation made on the customer's behalf (autobuyPlan).
  // `reservedNow` tracks what this run has already claimed so two wishes cannot
  // both reserve the last copy.
  const wantedMatches = new Map();
  const autobuyPlan = [];
  const reservedNow = new Map();
  for (const entry of entries) {
    for (const card of byName.get(entry.name.toLowerCase()) ?? []) {
      const free =
        availableOf(card, reserved, offSale) - (reservedNow.get(card.id) ?? 0);
      if (free <= 0) continue;
      if (!matches(entry, card)) continue;
      // The customer's own consigned card is theirs to take back — never a
      // purchase, so never auto-bought.
      const kind =
        card.collection?.playerid === entry.playerid ? "withdrawal" : "purchase";
      // A card with no price cannot be sold — customers do not even see it in
      // the store — so it must not raise a purchase match (or an auto-buy)
      // until the shop prices it. A withdrawal goes home for free, so price is
      // irrelevant there.
      if (kind === "purchase" && card.price == null) continue;
      if (kind === "purchase" && entry.autobuy) {
        const already = reservedForWish.get(entry.id) ?? 0;
        const need = entry.quantity - already;
        if (need <= 0) continue; // the wish is already fully reserved
        const take = Math.min(need, free);
        if (take <= 0) continue;
        autobuyPlan.push({ entry, card, count: take });
        reservedNow.set(card.id, (reservedNow.get(card.id) ?? 0) + take);
        reservedForWish.set(entry.id, already + take);
      } else {
        wantedMatches.set(`${entry.id}:${card.id}`, {
          wishlistid: entry.id,
          cardid: card.id,
          playerid: entry.playerid,
          kind,
        });
      }
    }
  }

  const existing = await prisma.wishlistmatch.findMany({
    where: { resolved: null },
  });
  const existingKeys = new Set(
    existing.map((m) => `${m.wishlistid}:${m.cardid}`)
  );

  const toCreate = [...wantedMatches.entries()]
    .filter(([key]) => !existingKeys.has(key))
    .map(([, value]) => ({ ...value, found: started }));

  // An unresolved match that no longer holds is withdrawn rather than left to
  // rot: the card sold, the entry was deleted, the filters moved, or the wish
  // turned into an auto-buy reservation.
  const stale = existing.filter(
    (m) => !wantedMatches.has(`${m.wishlistid}:${m.cardid}`)
  );

  if (!DRY_RUN) {
    if (toCreate.length) {
      await prisma.wishlistmatch.createMany({
        data: toCreate,
        skipDuplicates: true,
      });
    }
    if (stale.length) {
      await prisma.wishlistmatch.deleteMany({
        where: { id: { in: stale.map((m) => m.id) } },
      });
    }
    // Auto-buy: reserve each planned card into the customer's pending order,
    // linked to the wish so pulling it later answers (and removes) the wish.
    if (autobuyPlan.length) {
      const rate = await exchangeRate(prisma);
      for (const plan of autobuyPlan) {
        await prisma.$transaction((tx) =>
          reserveIntoBag(tx, plan.entry.playerid, plan.card, plan.count, rate, plan.entry.id)
        );
      }
    }
    await prisma.syncrun.create({
      data: {
        source: "wishlist_match",
        cards: toCreate.length + autobuyPlan.length,
        sets: stale.length,
        ok: true,
        started,
        finished: now(),
      },
    });
  }

  log(
    `${DRY_RUN ? "[dry run] " : ""}${entries.length} wishlist entries, ` +
      `${wantedMatches.size} match(es): ${toCreate.length} new, ${stale.length} withdrawn; ` +
      `${autobuyPlan.length} auto-buy reservation(s)`
  );
  for (const match of toCreate) {
    const entry = entries.find((e) => e.id === match.wishlistid);
    log(`  + ${entry?.player?.name} wants ${entry?.name} (${match.kind})`);
  }
  for (const plan of autobuyPlan) {
    log(`  → auto-buy ${plan.count}× ${plan.entry.name} for ${plan.entry.player?.name}`);
  }
  return {
    found: toCreate.length,
    autobought: autobuyPlan.length,
    cleared: stale.length,
    entries: entries.length,
  };
}

main()
  .catch(async (err) => {
    console.error("wishlist match failed:", err);
    process.exitCode = 1;
    try {
      await prisma.syncrun.create({
        data: {
          source: "wishlist_match",
          ok: false,
          error: String(err?.message ?? err).slice(0, 500),
          started: now(),
          finished: now(),
        },
      });
    } catch {
      // The database is what failed; nothing more to do.
    }
  })
  .finally(() => prisma.$disconnect());
