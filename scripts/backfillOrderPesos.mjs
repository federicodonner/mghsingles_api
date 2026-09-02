#!/usr/bin/env node
// One-off backfill: freeze a peso price on completed-purchase order lines that
// were bagged before the shop had pesos.
//
//   npm run backfill:orderpesos          # apply
//   npm run backfill:orderpesos -- --dry  # report only, write nothing
//
// Why this exists: a purchase's peso amount is normally frozen per line
// (`orderline.pricepesos`) the day the copy was bagged. Lines from before the
// shop quoted pesos have it null, and the app live-converts them at today's
// rate — fine on screen, but the amount then drifts with the rate. This writes
// the peso snapshot once, at the shop's CURRENT configured rate, so those old
// purchases read as a fixed peso amount like every newer one.
//
// Only completed orders are touched (a made purchase, its price final), only
// lines that carry a dollar price and have no peso value yet — so it is safe to
// run more than once: a second run finds nothing left to do.
import { createPrismaClient } from "../services/prisma.js";
import { exchangeRate, toPesos } from "../services/exchange.js";

const prisma = createPrismaClient();
const log = (msg) => process.stdout.write(`${msg}\n`);
const dry = process.argv.includes("--dry");

try {
  const rate = await exchangeRate(prisma);
  if (rate == null) {
    log(
      "No hay tipo de cambio configurado (Precios). Configuralo antes de correr el backfill."
    );
    process.exit(1);
  }
  log(`Tipo de cambio: ${rate} pesos/dólar${dry ? "  (DRY RUN)" : ""}`);

  // Lines that need a peso snapshot: no pesos yet, on a completed order.
  // (`price` is always present — it is a required column.)
  const lines = await prisma.orderline.findMany({
    where: {
      pricepesos: null,
      order: { is: { status: "completed" } },
    },
    select: { id: true, orderid: true, price: true },
  });

  if (!lines.length) {
    log("No hay líneas para actualizar. Nada que hacer.");
    process.exit(0);
  }

  const orders = new Set(lines.map((l) => l.orderid));
  log(`${lines.length} línea(s) en ${orders.size} pedido(s) completado(s).`);

  let written = 0;
  for (const line of lines) {
    const pricepesos = toPesos(Number(line.price), rate);
    log(
      `  pedido ${line.orderid} línea ${line.id}: U$S ${line.price} -> $ ${pricepesos}`
    );
    if (!dry) {
      await prisma.orderline.update({
        where: { id: line.id },
        data: { pricepesos },
      });
      written += 1;
    }
  }

  log(dry ? "DRY RUN: no se escribió nada." : `Listo. ${written} línea(s) actualizada(s).`);
} finally {
  await prisma.$disconnect();
}
