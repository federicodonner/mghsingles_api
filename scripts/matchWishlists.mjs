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
import { PrismaClient } from "@prisma/client";
import { matches } from "../routes/wishlist.js";
import {
  releaseExpiredOrders,
  reservedByCard,
  availableOf,
} from "../services/orders.js";

const prisma = new PrismaClient();
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

  const reserved = await reservedByCard(
    prisma,
    cards.map((c) => c.id)
  );

  const byName = new Map();
  for (const card of cards) {
    const key = (card.cardgeneral?.name ?? "").toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(card);
  }

  // What should exist right now.
  const wanted = new Map();
  for (const entry of entries) {
    for (const card of byName.get(entry.name.toLowerCase()) ?? []) {
      if (availableOf(card, reserved) <= 0) continue;
      if (!matches(entry, card)) continue;
      wanted.set(`${entry.id}:${card.id}`, {
        wishlistid: entry.id,
        cardid: card.id,
        playerid: entry.playerid,
        // The customer's own consigned card is theirs to take back.
        kind:
          card.collection?.playerid === entry.playerid
            ? "withdrawal"
            : "purchase",
      });
    }
  }

  const existing = await prisma.wishlistmatch.findMany({
    where: { resolved: null },
  });
  const existingKeys = new Set(
    existing.map((m) => `${m.wishlistid}:${m.cardid}`)
  );

  const toCreate = [...wanted.entries()]
    .filter(([key]) => !existingKeys.has(key))
    .map(([, value]) => ({ ...value, found: started }));

  // An unresolved match that no longer holds is withdrawn rather than left to
  // rot: the card sold, the entry was deleted, or the filters moved.
  const stale = existing.filter((m) => !wanted.has(`${m.wishlistid}:${m.cardid}`));

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
    await prisma.syncrun.create({
      data: {
        source: "wishlist_match",
        cards: toCreate.length,
        sets: stale.length,
        ok: true,
        started,
        finished: now(),
      },
    });
  }

  log(
    `${DRY_RUN ? "[dry run] " : ""}${entries.length} wishlist entries, ` +
      `${wanted.size} live match(es): ${toCreate.length} new, ${stale.length} withdrawn`
  );
  for (const match of toCreate) {
    const entry = entries.find((e) => e.id === match.wishlistid);
    log(`  + ${entry?.player?.name} wants ${entry?.name} (${match.kind})`);
  }
  return { found: toCreate.length, cleared: stale.length, entries: entries.length };
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
