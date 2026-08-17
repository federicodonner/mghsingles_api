// Ingest CardKingdom reference prices from MTGJSON.
//
// Written as a plain async function taking a PrismaClient, so the same code
// runs from the CLI (scripts/syncPrices.mjs), from a Heroku one-off dyno, or
// from an AWS Lambda (lambda/priceSync.mjs) without being restructured.
//
// It talks to the database DIRECTLY rather than posting to the API. The work is
// ~155k upserts: pushing that over HTTP would need batching, auth and a job
// that outlives API Gateway's 29s limit, and running it inside the web dyno
// would make price night compete with serving customers.
//
// The design turns on an asymmetry in MTGJSON's files:
//
//   AllPricesToday.json.gz     5 MB   changes every day
//   csv/cardIdentifiers.csv.gz 15 MB  never changes for an existing printing
//
// So the uuid -> scryfallId mapping is stored once on cardgeneral, and the
// daily job only fetches the small file. The mapping is refreshed only when
// printings are missing one, which happens when a new set arrives.
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import readline from "node:readline";
import { applyReferencePrices } from "./pricing.js";

const HEADERS = { "User-Agent": "mghsingles/1.0 (price sync)" };

const PRICES_URL =
  process.env.MTGJSON_PRICES_URL ||
  "https://mtgjson.com/api/v5/AllPricesToday.json.gz";
const IDENTIFIERS_URL =
  process.env.MTGJSON_IDENTIFIERS_URL ||
  "https://mtgjson.com/api/v5/csv/cardIdentifiers.csv.gz";

const SOURCE = "cardkingdom";
const BATCH = 500;

// MTGJSON names finishes normal / foil / etched; ours are Scryfall's, where
// "normal" is "nonfoil". Everything else already agrees.
const FINISH_FROM_MTGJSON = { normal: "nonfoil", foil: "foil", etched: "etched" };

const nowSeconds = () => Math.round(Date.now() / 1000);

async function gunzipToString(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const chunks = [];
  for await (const chunk of Readable.fromWeb(res.body).pipe(createGunzip())) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// --- identifier mapping ---------------------------------------------------

// Fill in cardgeneral.mtgjsonuuid wherever it is missing.
//
// Streams the CSV and only reads its first two columns (uuid, scryfallId), so
// the 30MB of other identifiers never lands in memory.
export async function syncIdentifiers(
  prisma,
  { log = () => {}, force = false } = {}
) {
  const missing = await prisma.cardgeneral.count({ where: { mtgjsonuuid: null } });
  if (!missing) {
    log("identifiers: every printing already mapped");
    return { mapped: 0, missing: 0, skipped: true };
  }

  // Some printings will NEVER be in MTGJSON — tokens and a long tail of promos
  // — so "anything unmapped" is not a reason to refetch. Compare against the
  // count left over last time instead: only a HIGHER number means new printings
  // have arrived that the map could actually resolve. Without this the 15MB
  // file would be downloaded every single night to map nothing.
  const last = await prisma.syncrun.findFirst({
    where: { source: "mtgjson_identifiers", ok: true },
    orderBy: { started: "desc" },
  });
  if (!force && last && missing <= last.cards) {
    log(
      `identifiers: ${missing} unmapped, unchanged since the last attempt — ` +
        `these are printings MTGJSON does not carry (--force to refetch)`
    );
    return { mapped: 0, missing, skipped: true };
  }

  log(`identifiers: ${missing} printing(s) unmapped, fetching the map`);

  const res = await fetch(IDENTIFIERS_URL, { headers: HEADERS });
  if (!res.ok) throw new Error(`${IDENTIFIERS_URL}: HTTP ${res.status}`);

  const rl = readline.createInterface({
    input: Readable.fromWeb(res.body).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let header = true;
  let pending = [];
  let mapped = 0;

  const flush = async () => {
    if (!pending.length) return;
    const values = [];
    const rows = pending.map((pair, n) => {
      values.push(pair[0], pair[1]);
      return `($${n * 2 + 1},$${n * 2 + 2})`;
    });
    // Only fills gaps: an existing mapping is never rewritten, and a scryfallId
    // MTGJSON knows about that we do not is simply ignored by the join.
    await prisma.$executeRawUnsafe(
      `UPDATE cardgeneral AS c SET mtgjsonuuid = v.uuid
       FROM (VALUES ${rows.join(",")}) AS v(uuid, scryfallid)
       WHERE c.scryfallid = v.scryfallid AND c.mtgjsonuuid IS NULL`,
      ...values
    );
    pending = [];
  };

  for await (const line of rl) {
    if (header) {
      header = false;
      continue;
    }
    if (!line) continue;
    // uuid and scryfallId are the first two columns; nothing after matters.
    const first = line.indexOf(",");
    const second = line.indexOf(",", first + 1);
    if (first === -1) continue;
    const uuid = line.slice(0, first);
    const scryfallid =
      second === -1 ? line.slice(first + 1) : line.slice(first + 1, second);
    if (!uuid || !scryfallid) continue;
    pending.push([uuid, scryfallid]);
    mapped++;
    if (pending.length >= BATCH) await flush();
  }
  await flush();

  const stillMissing = await prisma.cardgeneral.count({
    where: { mtgjsonuuid: null },
  });
  // Remember the leftover count, so the next run can tell "nothing new" from
  // "new printings arrived".
  await prisma.syncrun.create({
    data: {
      source: "mtgjson_identifiers",
      cards: stillMissing,
      sets: mapped,
      ok: true,
      started: nowSeconds(),
      finished: nowSeconds(),
    },
  });
  log(`identifiers: ${mapped} rows read, ${stillMissing} printing(s) still unmapped`);
  return { mapped, missing: stillMissing, skipped: false };
}

// --- prices ---------------------------------------------------------------

// Pull the newest quote out of a `{ "YYYY-MM-DD": price }` block. The "today"
// file normally carries one date, but taking the max is cheap insurance
// against a file that carries several.
function newestQuote(block) {
  if (!block) return { price: null, date: null };
  let date = null;
  for (const key of Object.keys(block)) {
    if (date === null || key > date) date = key;
  }
  return date === null ? { price: null, date: null } : { price: block[date], date };
}

export async function syncPrices(prisma, { log = () => {}, force = false } = {}) {
  const started = nowSeconds();

  // Anything new since the last run needs a uuid before it can be priced.
  const identifiers = await syncIdentifiers(prisma, { log, force });

  log("prices: downloading AllPricesToday");
  const doc = JSON.parse(await gunzipToString(PRICES_URL));
  const priced = Object.keys(doc.data ?? {});
  log(`prices: ${priced.length} card(s) in the file, dated ${doc.meta?.date}`);

  // Only printings we actually hold are worth looking up.
  const known = await prisma.cardgeneral.findMany({
    where: { mtgjsonuuid: { not: null } },
    select: { scryfallid: true, mtgjsonuuid: true },
  });
  const scryfallByUuid = new Map(known.map((c) => [c.mtgjsonuuid, c.scryfallid]));
  log(`prices: ${scryfallByUuid.size} printing(s) mapped locally`);

  const updated = nowSeconds();
  let rows = [];
  let written = 0;
  let skippedUnknown = 0;

  const flush = async () => {
    if (!rows.length) return;
    const values = [];
    // `updated` is the same for every row in the run, so it goes in as a
    // literal rather than repeating a parameter 500 times. Prices are cast in
    // SQL so Postgres parses the decimal exactly instead of via a JS float.
    const tuples = rows.map((row, n) => {
      const b = n * 7;
      values.push(...row);
      return (
        `($${b + 1},$${b + 2},$${b + 3},` +
        `$${b + 4}::numeric,$${b + 5}::numeric,$${b + 6},$${b + 7},${updated})`
      );
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO cardprice (scryfallid, source, finish, retail, buylist, currency, pricedate, updated)
       VALUES ${tuples.join(",")}
       ON CONFLICT (scryfallid, source, finish) DO UPDATE SET
         retail    = EXCLUDED.retail,
         buylist   = EXCLUDED.buylist,
         currency  = EXCLUDED.currency,
         pricedate = EXCLUDED.pricedate,
         updated   = EXCLUDED.updated`,
      ...values
    );
    written += rows.length;
    rows = [];
  };

  for (const uuid of priced) {
    const scryfallid = scryfallByUuid.get(uuid);
    if (!scryfallid) {
      skippedUnknown++;
      continue;
    }
    const ck = doc.data[uuid]?.paper?.[SOURCE];
    if (!ck) continue;

    // Retail and buylist are separate blocks; a finish may appear in one and
    // not the other, so the union of both decides which rows exist.
    const finishes = new Set([
      ...Object.keys(ck.retail ?? {}),
      ...Object.keys(ck.buylist ?? {}),
    ]);
    for (const mtgjsonFinish of finishes) {
      const finish = FINISH_FROM_MTGJSON[mtgjsonFinish];
      if (!finish) continue; // an unfamiliar finish is left alone, not guessed at
      const retail = newestQuote(ck.retail?.[mtgjsonFinish]);
      const buylist = newestQuote(ck.buylist?.[mtgjsonFinish]);
      rows.push([
        scryfallid,
        SOURCE,
        finish,
        retail.price ?? null,
        buylist.price ?? null,
        ck.currency ?? null,
        retail.date ?? buylist.date ?? doc.meta?.date ?? null,
      ]);
      if (rows.length >= BATCH) await flush();
    }
  }
  await flush();

  // References are only half the job: the shop's own prices are derived from
  // them, honouring locks and never clearing a price the source has dropped.
  const applied = await applyReferencePrices(prisma, { log });

  const secs = nowSeconds() - started;
  log(
    `prices: ${written} price row(s) written, ${skippedUnknown} card(s) we do not stock, in ${secs}s`
  );

  return {
    applied,
    started,
    finished: nowSeconds(),
    written,
    skippedUnknown,
    pricedate: doc.meta?.date ?? null,
    identifiers,
  };
}

export default syncPrices;
