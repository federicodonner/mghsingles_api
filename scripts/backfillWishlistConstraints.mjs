#!/usr/bin/env node
// One-off: turn wishlist entries' old "empty list = any" constraints into the
// explicit lists the editor now works with (2026-11-22).
//
//   npm run backfill:wishlistconstraints          # apply
//   npm run backfill:wishlistconstraints -- --dry # report only
//
// For every entry, each EMPTY category (versions, languages, grades, finishes)
// is filled with every option that card has today. Categories that already
// list something are left exactly as they are. Matching does not change: an
// empty list matched everything, and the full list matches everything that
// exists now. Safe to run more than once — a second run finds nothing empty.
import { createPrismaClient } from "../services/prisma.js";
import {
  allOptions,
  sharedOptions,
  fillEmpty,
  CATEGORIES,
} from "../services/wishlistOptions.js";

const prisma = createPrismaClient();
const log = (msg) => process.stdout.write(`${msg}\n`);
const dry = process.argv.includes("--dry");

try {
  const entries = await prisma.wishlist.findMany({ orderBy: { id: "asc" } });
  const shared = await sharedOptions(prisma);
  const optionsByName = new Map();

  let changed = 0;
  for (const entry of entries) {
    const empty = CATEGORIES.filter((key) => !entry[key].length);
    if (!empty.length) continue;

    const key = entry.name.toLowerCase();
    if (!optionsByName.has(key)) {
      optionsByName.set(key, await allOptions(prisma, entry.name, shared));
    }
    const filled = fillEmpty(entry, optionsByName.get(key));
    const data = Object.fromEntries(empty.map((k) => [k, filled[k]]));

    log(
      `  #${entry.id} ${entry.name} (player ${entry.playerid}): ` +
        empty.map((k) => `${k}=${data[k].length}`).join(", ")
    );
    if (!dry) await prisma.wishlist.update({ where: { id: entry.id }, data });
    changed++;
  }

  log(
    `${changed} de ${entries.length} deseado(s) ${dry ? "se actualizarían (DRY RUN)" : "actualizados"}.`
  );
} finally {
  await prisma.$disconnect();
}
