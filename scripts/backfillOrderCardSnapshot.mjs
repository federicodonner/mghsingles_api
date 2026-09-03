#!/usr/bin/env node
// One-off backfill: freeze the card identity onto completed order lines that
// still have a live card but no snapshot yet.
//
//   npm run backfill:cardsnapshot          # apply
//   npm run backfill:cardsnapshot -- --dry # report only
//
// Why: a completed order's line used to lose its card (name/set/image) — and,
// before the ON DELETE CASCADE was changed to SET NULL, the whole line — the
// moment the card's last copy sold out. New completions now snapshot the card
// onto the line. This does the same for orders completed earlier, while their
// cards still exist, so a later stock-out cannot blank them.
//
// Lines whose card is ALREADY gone cannot be recovered here (the old cascade
// deleted them); this only protects the ones still intact. Idempotent: a line
// that already has a snapshot is skipped.
import { createPrismaClient } from "../services/prisma.js";
import { cardSnapshot } from "../services/orders.js";

const prisma = createPrismaClient();
const log = (msg) => process.stdout.write(`${msg}\n`);
const dry = process.argv.includes("--dry");

try {
  const lines = await prisma.orderline.findMany({
    where: {
      cardname: null,
      cardid: { not: null },
      // Any order that has left pending is history the customer can see —
      // completed and cancelled both.
      order: { is: { status: { not: "pending" } } },
    },
    include: { card: { include: { cardgeneral: true } } },
  });

  if (!lines.length) {
    log("No hay líneas para snapshotear. Nada que hacer.");
    process.exit(0);
  }
  log(`${lines.length} línea(s) de pedidos cerrados a congelar${dry ? "  (DRY RUN)" : ""}.`);

  let written = 0;
  for (const line of lines) {
    const snap = cardSnapshot(line.card);
    log(`  línea ${line.id} (pedido ${line.orderid}): ${snap.cardname ?? "?"} (${snap.cardsetcode ?? "?"})`);
    if (!dry) {
      await prisma.orderline.update({ where: { id: line.id }, data: snap });
      written += 1;
    }
  }
  log(dry ? "DRY RUN: no se escribió nada." : `Listo. ${written} línea(s) congelada(s).`);
} finally {
  await prisma.$disconnect();
}
