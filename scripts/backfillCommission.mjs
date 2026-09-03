#!/usr/bin/env node
// One-off: move existing consignors from the old 30% store cut to the new 25%.
//
//   npm run backfill:commission          # apply
//   npm run backfill:commission -- --dry # report only
//
// `collection.percent` is the STORE's cut; the standard consignment rate went
// from 0.30 to 0.25 (2026-09-02). New customer collections are created at 0.25
// already; this updates the CUSTOMER collections still sitting at exactly 0.30
// so their FUTURE sales snapshot 0.25. It does NOT touch shop staff/owner
// collections (which hold the shop's own stock), negotiated custom rates, or
// already-recorded sales — a sale's percent is frozen when it happens, so past
// sales keep the terms they were made under.
import { createPrismaClient } from "../services/prisma.js";
import { Prisma } from "@prisma/client";

const prisma = createPrismaClient();
const log = (msg) => process.stdout.write(`${msg}\n`);
const dry = process.argv.includes("--dry");
const OLD = new Prisma.Decimal("0.30");
const NEW = new Prisma.Decimal("0.25");
// Only consignors (customers). Staff/owner collections are shop stock.
const WHERE = { percent: OLD, player: { is: { role: "customer" } } };

try {
  const rows = await prisma.collection.findMany({
    where: WHERE,
    select: { id: true, player: { select: { name: true, email: true } } },
  });
  if (!rows.length) {
    log("No hay colecciones de clientes al 30%. Nada que hacer.");
    process.exit(0);
  }
  log(`${rows.length} colección(es) de clientes al 30% -> 25%${dry ? "  (DRY RUN)" : ""}:`);
  for (const r of rows) {
    log(`  colección ${r.id} — ${r.player?.name ?? "?"} (${r.player?.email ?? "?"})`);
  }
  if (!dry) {
    const { count } = await prisma.collection.updateMany({
      where: WHERE,
      data: { percent: NEW },
    });
    log(`Listo. ${count} colección(es) actualizada(s) a 25%.`);
  } else {
    log("DRY RUN: no se escribió nada.");
  }
} finally {
  await prisma.$disconnect();
}
