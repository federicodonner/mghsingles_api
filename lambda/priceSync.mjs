// AWS Lambda entry point for the daily CardKingdom price sync.
//
// Deploy alongside the API repo (or as a container image built from it) and
// point an EventBridge schedule at it. The actual work lives in
// services/priceSync.mjs — this file only adapts it to Lambda's calling
// convention, so the CLI and the Lambda can never drift apart.
//
// Notes for deploying this on AWS:
//
//  * The database is reached DIRECTLY. Heroku Postgres is publicly addressable,
//    so no VPC configuration is needed; set DATABASE_URL in the function's
//    environment. If the database ever moves inside a VPC, the function has to
//    move with it and will then need a NAT for the MTGJSON download.
//
//  * No native binary to worry about. Prisma 6 shipped a Rust query engine
//    compiled per platform, so a bundle zipped on macOS carried a darwin binary
//    and failed only once deployed — the fix was a `binaryTargets` entry in
//    schema.prisma, or building in a container. Prisma 7 removed the engine
//    entirely and talks to Postgres through the `pg` driver adapter, so the
//    bundle is portable and about a third of the size.
//
//  * Timeout: the run takes ~15s against a warm database, and the first run
//    also downloads the 15MB identifier map. Allow 5 minutes. Memory 512MB is
//    enough; the price file is ~50MB once decompressed.
//
//  * One connection per invocation. The client is created outside the handler
//    so a warm container reuses it, and is deliberately NOT disconnected on
//    success for the same reason.
import { createPrismaClient } from "../services/prisma.js";
import { syncPrices } from "../services/priceSync.mjs";

const prisma = createPrismaClient();

export async function handler() {
  const lines = [];
  const log = (msg) => {
    lines.push(msg);
    console.log(msg);
  };

  try {
    const result = await syncPrices(prisma, { log });
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
    return { ok: true, written: result.written, pricedate: result.pricedate };
  } catch (err) {
    console.error("price sync failed:", err);
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
    // Rethrow so the invocation is marked failed and EventBridge/CloudWatch
    // can alarm on it. Returning ok:false would look like success.
    throw err;
  }
}

export default handler;
