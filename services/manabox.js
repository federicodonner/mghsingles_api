// Importing a ManaBox scan into a container.
//
// ManaBox (the scanning app) exports CSV with one row per card:
//   Name, Set code, Set name, Collector number, Foil, Rarity, Quantity,
//   ManaBox ID, Scryfall ID, Purchase price, Misprint, Altered, Condition,
//   Language, Purchase currency
//
// The Scryfall ID identifies the exact printing, so resolution is exact when
// it is present; set code + collector number is the fallback for a file that
// lost the column. Condition and language are recorded FAITHFULLY — the shop
// currently hides both in the UI, but the data is the point of scanning
// (see services/identity.js for the hide-don't-drop decision).
//
// Binders read the file as a map of the physical binder: the Nth data line is
// the Nth pocket (nine per page), and an EMPTY line means that pocket is
// empty in real life and must be skipped. Boxes just take the cards in order.
import { finishesFor } from "./finishes.js";
import { isPaperPrinting } from "./paper.js";
import { addPrintingCopy } from "./copies.js";
import { setBinderPosition, POCKETS_PER_PAGE } from "./storageContents.js";

// ManaBox's seven grades onto the shop's five, order preserved. Keys are in
// NORMALISED form (lowercase, separators stripped) because that is how the
// lookup reads them — "near_mint" arrives here as "nearmint".
const CONDITION_MAP = {
  mint: "NM",
  nearmint: "NM",
  excellent: "EX",
  good: "VG",
  lightplayed: "G",
  played: "G",
  poor: "damaged",
};

// ManaBox language codes onto the shop's language names. Languages the shop
// does not track (Russian, Korean, Italian...) fall back to English rather
// than failing the row — the card itself is what matters.
const LANGUAGE_MAP = {
  en: "Inglés",
  es: "Español",
  sp: "Español",
  fr: "Francés",
  pt: "Portugués",
  de: "Alemán",
  ja: "Japonés",
  jp: "Japonés",
  zh: "Chino",
  zhs: "Chino",
  zht: "Chino",
};

const FINISH_MAP = { normal: "nonfoil", nonfoil: "nonfoil", foil: "foil", etched: "etched" };

// One CSV line into fields, honouring quotes ("a, b" is one field, "" is an
// escaped quote). ManaBox's own export is simple, but a file that went
// through a spreadsheet once will have quoting.
function splitCsvLine(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

// Header names normalised for lookup: "Collector number" -> "collectornumber".
const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// The CSV as a list of entries in file order: { blank: true } for an empty
// line (a pocket to skip), or the row's fields keyed by normalised header.
export function parseManaBox(text) {
  const lines = String(text).replace(/^﻿/, "").split(/\r\n|\r|\n/);

  // The header is the first line with content. Everything before the file's
  // first card is structure, not pockets, so leading blanks are dropped.
  let headerIndex = lines.findIndex((line) => line.trim() !== "");
  if (headerIndex === -1) return { header: null, entries: [] };
  const header = splitCsvLine(lines[headerIndex]).map(normalise);
  if (!header.includes("name")) {
    return { header: null, entries: [] };
  }

  const entries = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const raw = lines[i];
    // Empty, whitespace or a line of bare commas (a spreadsheet's idea of an
    // empty row) all mean "skip this pocket".
    if (raw.replace(/[,\s]/g, "") === "") {
      entries.push({ blank: true, line: i + 1 });
      continue;
    }
    const fields = splitCsvLine(raw);
    const row = { line: i + 1 };
    header.forEach((key, index) => {
      if (key) row[key] = fields[index] ?? "";
    });
    entries.push(row);
  }
  // Trailing blank lines are the end of the file, not empty pockets.
  while (entries.length && entries[entries.length - 1].blank) entries.pop();
  return { header, entries };
}

// Run the import. `unit` is the container, `collectionid` whose cards these
// become. Returns a summary; never throws for a bad ROW — those are reported
// per line so one typo does not void a whole scan.
// Ceilings on one import, so a single request cannot drive unbounded database
// work. The 2mb body limit bounds the row COUNT loosely; these bound the work
// each import can actually do. A real scanned binder or box is well within
// both.
const MAX_ROWS = 5000;
const MAX_ROW_QUANTITY = 100;

export async function importManaBox(prisma, unit, collectionid, text) {
  const { header, entries } = parseManaBox(text);
  if (!header) {
    return { ok: false, added: 0, skipped: 0, errors: [], badFile: true };
  }
  if (entries.length > MAX_ROWS) {
    return { ok: false, added: 0, skipped: 0, errors: [], tooLarge: true };
  }

  const [conditions, languages] = await Promise.all([
    prisma.cardcondition.findMany(),
    prisma.cardlanguage.findMany(),
  ]);
  const conditionByName = new Map(conditions.map((c) => [c.name, c.id]));
  const languageByName = new Map(languages.map((l) => [l.name, l.id]));
  const fallbackCondition = conditionByName.get("NM") ?? conditions[0]?.id;
  const fallbackLanguage = languageByName.get("Inglés") ?? languages[0]?.id;

  let added = 0;
  let skipped = 0;
  const errors = [];
  // The next pocket a card would land in, advanced by every entry — card or
  // blank — so the file's shape IS the binder's shape. The scan continues the
  // binder rather than restarting it: counting begins after the LAST occupied
  // pocket, because the person scanned the pages that come after what is
  // already filed. Bagged copies count as occupied — their pocket is spoken
  // for until the order resolves.
  let pocketIndex = 0;
  if (unit.type === "binder") {
    const occupied = await prisma.cardplacement.findMany({
      where: { storageid: unit.id, page: { not: null } },
      select: { page: true, pocket: true },
    });
    pocketIndex = occupied.reduce(
      (last, pl) =>
        Math.max(last, (pl.page - 1) * POCKETS_PER_PAGE + pl.pocket),
      0
    );
  }

  for (const entry of entries) {
    pocketIndex++;
    if (entry.blank) {
      skipped++;
      continue;
    }

    const fail = (reason) =>
      errors.push({ line: entry.line, name: entry.name || null, reason });

    // The printing: exact by Scryfall id, else set code + collector number.
    let printing = null;
    if (entry.scryfallid) {
      printing = await prisma.cardgeneral.findUnique({
        where: { scryfallid: entry.scryfallid },
      });
    }
    if (!printing && entry.setcode && entry.collectornumber) {
      printing = await prisma.cardgeneral.findFirst({
        where: {
          cardsetcode: { equals: entry.setcode, mode: "insensitive" },
          collectornumber: String(entry.collectornumber),
        },
      });
    }
    if (!printing) {
      fail("printing_not_found");
      continue;
    }
    if (!isPaperPrinting(printing)) {
      fail("not_paper");
      continue;
    }

    const variant = FINISH_MAP[normalise(entry.foil ?? "")] ?? "nonfoil";
    if (!finishesFor(printing).includes(variant)) {
      fail("finish_not_available");
      continue;
    }

    const conditionid =
      conditionByName.get(CONDITION_MAP[normalise(entry.condition ?? "")]) ??
      fallbackCondition;
    const languageid =
      languageByName.get(LANGUAGE_MAP[(entry.language ?? "").toLowerCase()]) ??
      fallbackLanguage;

    // Clamp per-row quantity. `Math.max` only bounded the floor, so a single
    // row with Quantity=2000000000 drove billions of sequential inserts in one
    // request. A scanned stack in one sleeve is realistically a few dozen.
    const quantity = Math.min(
      MAX_ROW_QUANTITY,
      Math.max(1, parseInt(entry.quantity, 10) || 1)
    );
    const position =
      unit.type === "binder"
        ? {
            page: Math.floor((pocketIndex - 1) / POCKETS_PER_PAGE) + 1,
            pocket: ((pocketIndex - 1) % POCKETS_PER_PAGE) + 1,
          }
        : null;

    // Copies one at a time — the copy allocator inside addPrintingCopy is
    // sequential by design. A multi-copy row stacks in its one pocket, the
    // way a scanned stack sits in the sleeve.
    for (let i = 0; i < quantity; i++) {
      const placement = await addPrintingCopy(prisma, unit, collectionid, {
        scryfallid: printing.scryfallid,
        conditionid,
        languageid,
        variant,
        // A sorted box appends: the file is in order, and each row going to
        // the front would file the whole scan reversed.
        sortedEnd: true,
      });
      if (position) {
        await setBinderPosition(
          prisma,
          { ...placement, storage: unit },
          position
        );
      }
      added++;
    }
  }

  return { ok: true, added, skipped, errors };
}
