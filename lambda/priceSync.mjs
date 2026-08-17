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
//  * Prisma ships a native query engine per platform. Building on macOS and
//    zipping will NOT work — add the Lambda target to schema.prisma:
//      generator client { binaryTargets = ["native", "rhel-openssl-3.0.x"] }
//    or deploy as a container image built on Amazon Linux, which avoids the
//    question entirely.
//
//  * Timeout: the run takes ~15s against a warm database, and the first run
//    also downloads the 15MB identifier map. Allow 5 minutes. Memory 512MB is
//    enough; the price file is ~50MB once decompressed.
//
//  * One connection per invocation. The client is created outside the handler
//    so a warm container reuses it, and is deliberately NOT disconnected on
//    success for the same reason.
import { PrismaClient } from "@prisma/client";
import { syncPrices } from "../services/priceSync.mjs";

const prisma = new PrismaClient();

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
