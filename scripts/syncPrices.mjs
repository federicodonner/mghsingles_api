#!/usr/bin/env node
// CLI wrapper around the price sync.
//
//   npm run sync:prices
//
// The logic lives in services/priceSync.mjs so the identical code can run from
// a Lambda (see lambda/priceSync.mjs) without being duplicated or restructured.
import { createPrismaClient } from "../services/prisma.js";
import { syncPrices } from "../services/priceSync.mjs";

const prisma = createPrismaClient();
const log = (msg) => process.stdout.write(`${msg}\n`);

try {
  const result = await syncPrices(prisma, {
    log,
    // --force refetches the identifier map even when nothing new has appeared.
    force: process.argv.includes("--force"),
  });
  await prisma.syncrun.create({
    data: {
      source: "cardkingdom_prices",
      bulkupdated: result.pricedate,
      cards: result.written,
      sets: result.identifiers.mapped,
      ok: true,
      started: result.started,
      finished: result.finished,
    },
  });
} catch (err) {
  console.error("price sync failed:", err);
  process.exitCode = 1;
  try {
    await prisma.syncrun.create({
      data: {
        source: "cardkingdom_prices",
        ok: false,
        error: String(err?.message ?? err).slice(0, 500),
        started: Math.round(Date.now() / 1000),
        finished: Math.round(Date.now() / 1000),
      },
    });
  } catch {
    // The database is what failed; nothing more to record with.
  }
} finally {
  await prisma.$disconnect();
}
