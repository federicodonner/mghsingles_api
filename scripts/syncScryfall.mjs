#!/usr/bin/env node
// Pull Scryfall's `default_cards` bulk file into cardset + cardgeneral.
//
//   node -r dotenv/config scripts/syncScryfall.mjs
//   node -r dotenv/config scripts/syncScryfall.mjs --limit 2000   # quick check
//   node -r dotenv/config scripts/syncScryfall.mjs --dry-run
//
// Meant to run nightly (see SKILL.md). The point is to keep card names, images,
// set data and printing variants locally so the apps never call Scryfall on a
// page load.
//
// `default_cards` is one row per printing — the granularity this schema needs,
// since a card row points at a specific `scryfallid`. Scryfall publishes it as
// gzipped JSONL (~77MB compressed, ~110k lines), so this streams line by line
// and never holds the file in memory. Do not switch to the plain-JSON variant:
// parsing it needs the whole ~500MB document resident.
//
// Rows are never deleted. `card` and `sale` both reference cardgeneral, so a
// printing that vanishes upstream stays put rather than breaking a sale record.
import { PrismaClient } from "@prisma/client";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import readline from "node:readline";

// Scryfall returns an empty body to clients that do not identify themselves,
// with no error — every field silently arrives undefined.
const HEADERS = {
  "User-Agent": "mghsingles/1.0 (https://github.com/federicodonner/mghsingles_api)",
  Accept: "application/json",
};

const BULK_INDEX = process.env.SCRYFALL_BULK_URL || "https://api.scryfall.com/bulk-data";
const SETS_URL = "https://api.scryfall.com/sets";
const BATCH = 500; // rows per INSERT; 500 x 16 params stays well under Postgres' 65535

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i === -1 ? Infinity : parseInt(args[i + 1], 10);
})();

const prisma = new PrismaClient();

// Colours are stored in WUBRG order so the same card always yields the same
// string, whatever order Scryfall happens to list them in.
const WUBRG = ["W", "U", "B", "R", "G"];
const sortWUBRG = (a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// --- indexes --------------------------------------------------------------
// Card search is a substring match on name, which is a sequential scan over
// ~117k rows without help (~56ms, and worsening every set). A trigram index
// takes it to well under a millisecond.
//
// This lives here rather than in schema.prisma because Prisma cannot express a
// GIN trigram index, and the project has no migration files. Both statements
// are idempotent, so the sync self-heals a database that predates them.
async function ensureIndexes() {
  await prisma.$executeRawUnsafe(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS cardgeneral_name_trgm
       ON cardgeneral USING gin (LOWER(name) gin_trgm_ops)`
  );
}

// --- sets -----------------------------------------------------------------
// cardgeneral.cardsetcode is a foreign key, so every set must exist first.
async function syncSets() {
  const sets = [];
  let url = SETS_URL;
  while (url) {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`sets: HTTP ${res.status}`);
    const page = await res.json();
    sets.push(...page.data);
    url = page.has_more ? page.next_page : null;
  }
  log(`sets: ${sets.length} from Scryfall`);
  if (DRY_RUN) return new Set(sets.map((s) => s.code));

  for (let i = 0; i < sets.length; i += BATCH) {
    const slice = sets.slice(i, i + BATCH);
    const values = [];
    const rows = slice.map((s, n) => {
      const b = n * 4;
      values.push(s.code, s.name, new Date(s.released_at ?? "1993-08-05"), s.icon_svg_uri ?? null);
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO cardset (cardset, cardsetname, releasedate, iconsvguri)
       VALUES ${rows.join(",")}
       ON CONFLICT (cardset) DO UPDATE SET
         cardsetname = EXCLUDED.cardsetname,
         releasedate = EXCLUDED.releasedate,
         iconsvguri  = EXCLUDED.iconsvguri`,
      ...values
    );
  }
  return new Set(sets.map((s) => s.code));
}

// --- cards ----------------------------------------------------------------
function toRow(card, now) {
  // Double-faced cards carry their art on the front face rather than the card.
  const image =
    card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? null;

  const frameEffects = card.frame_effects ?? [];
  const promoTypes = card.promo_types ?? [];

  return [
    card.id,
    card.name,
    card.set,
    card.set_name,
    image,
    // Variant flags, kept identical to what the previous importer derived.
    card.border_color === "borderless",
    frameEffects.includes("showcase"),
    card.lang === "ph",
    frameEffects.includes("extendedart"),
    card.frame === "1997",
    promoTypes.includes("boxtopper"),
    (card.colors ?? []).slice().sort(sortWUBRG).join("") || null,
    card.rarity ?? null,
    card.collector_number ?? null,
    card.released_at ? Number(card.released_at.slice(0, 4)) : null,
    // Prices ride along free in the same payload. Nothing reads them yet.
    card.prices?.usd ?? null,
    card.prices?.usd_foil ?? null,
    card.prices?.eur ?? null,
    now,
  ];
}

const COLUMNS = [
  "scryfallid", "name", "cardsetcode", "cardsetname", "image",
  "borderless", "showcase", "phyrexian", "extendedart", "retroframe",
  "boxtopper", "color", "rarity", "collectornumber", "releasedatyear",
  "priceusd", "priceusdfoil", "priceeur", "pricesupdated",
];

// Scryfall sends prices as strings ("0.35"). Cast them in SQL rather than
// converting through a JS number: Postgres parses the decimal exactly, where
// a float round-trip would not.
const CASTS = {
  priceusd: "::numeric",
  priceusdfoil: "::numeric",
  priceeur: "::numeric",
};

async function flush(rows) {
  if (!rows.length) return;
  const values = [];
  const tuples = rows.map((row, n) => {
    const base = n * COLUMNS.length;
    values.push(...row);
    return `(${COLUMNS.map(
      (col, c) => `$${base + c + 1}${CASTS[col] ?? ""}`
    ).join(",")})`;
  });
  const updates = COLUMNS.filter((c) => c !== "scryfallid")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  await prisma.$executeRawUnsafe(
    `INSERT INTO cardgeneral (${COLUMNS.join(",")})
     VALUES ${tuples.join(",")}
     ON CONFLICT (scryfallid) DO UPDATE SET ${updates}`,
    ...values
  );
}

async function main() {
  const started = Date.now();

  const index = await fetch(BULK_INDEX, { headers: HEADERS });
  if (!index.ok) throw new Error(`bulk index: HTTP ${index.status}`);
  const entry = (await index.json()).data.find((d) => d.type === "default_cards");
  if (!entry) throw new Error("no default_cards entry in the bulk index");
  log(`bulk: default_cards updated ${entry.updated_at}`);

  if (!DRY_RUN) await ensureIndexes();
  const knownSets = await syncSets();

  const res = await fetch(entry.jsonl_download_uri, { headers: HEADERS });
  if (!res.ok) throw new Error(`bulk download: HTTP ${res.status}`);

  const rl = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  const now = Math.round(Date.now() / 1000);
  let seen = 0;
  let written = 0;
  let skipped = 0;
  const missingSets = new Set();
  let batch = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (seen >= LIMIT) break;
    seen++;

    const card = JSON.parse(line);

    // A card whose set is not in cardset would violate the foreign key.
    if (!knownSets.has(card.set)) {
      missingSets.add(card.set);
      skipped++;
      continue;
    }

    batch.push(toRow(card, now));
    if (batch.length >= BATCH) {
      if (!DRY_RUN) await flush(batch);
      written += batch.length;
      batch = [];
      if (written % 10000 === 0) log(`  ${written} cards...`);
    }
  }
  if (batch.length) {
    if (!DRY_RUN) await flush(batch);
    written += batch.length;
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(
    `${DRY_RUN ? "[dry run] " : ""}cards: ${written} written, ${skipped} skipped, ` +
      `${seen} read in ${secs}s`
  );
  if (missingSets.size) {
    log(`  sets missing from /sets, cards skipped: ${[...missingSets].join(", ")}`);
  }
}

main()
  .catch((err) => {
    console.error("scryfall sync failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
