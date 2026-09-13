// Importing a collection export into a container.
//
// Two apps export the cards someone owns as CSV, and the shop imports either
// without the person having to say which:
//
//   ManaBox (a scanning app) — one row per card, and for a binder scan an EMPTY
//   line means "this pocket is empty in real life, skip it":
//     Name, Set code, Set name, Collector number, Foil, Rarity, Quantity,
//     ManaBox ID, Scryfall ID, Purchase price, Misprint, Altered, Condition,
//     Language, Purchase currency
//
//   Delver (delver.app) — a collection list, no pocket layout, and its Rules
//   Text/Notes columns hold quoted multi-line text (which is why the CSV reader
//   below is record-based, not line-based):
//     Quantity, Card Name, Set, Set Code, Number, Foil/Etched, Unit Price,
//     Total Price, Custom Price, Scryfall Id, ... , Rarity, Type Line, ...
//
// Both carry a Scryfall Id, so resolution is exact when it is present; set code
// + collector number is the fallback. Delver has no condition/language columns,
// so those fall back to NM / English (the shop hides both in the UI anyway —
// see services/identity.js for the hide-don't-drop decision).
//
// Binders read the file as a map of the physical binder: the Nth card line is
// the Nth pocket (nine per page). Delver files have no blank lines, so they
// simply fill pockets in order; a ManaBox binder scan's blanks skip pockets.
import { finishesFor } from "./finishes.js";
import { isPaperPrinting } from "./paper.js";
import { addPrintingCopy } from "./copies.js";
import { setBinderPosition, POCKETS_PER_PAGE } from "./storageContents.js";

// ManaBox's seven grades onto the shop's five, order preserved. Keys are in
// NORMALISED form (lowercase, separators stripped) — "near_mint" -> "nearmint".
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
// does not track fall back to English rather than failing the row.
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

// Finish words (both apps) onto the shop's three. Delver writes "Foil"/"Etched"
// or leaves it blank; ManaBox writes "normal"/"foil"/"etched".
const FINISH_MAP = {
  "": "nonfoil",
  normal: "nonfoil",
  nonfoil: "nonfoil",
  regular: "nonfoil",
  foil: "foil",
  etched: "etched",
};

// Header names normalised for lookup: "Collector number" -> "collectornumber".
const normalise = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// A CSV reader that yields RECORDS, not lines: a quoted field may contain
// commas AND newlines (Delver's Rules Text does), so splitting on line breaks
// first — the way a line-based reader must — would tear those rows apart.
// Honours "" as an escaped quote. Handles \n, \r\n and lone \r row endings.
export function parseCsvRecords(text) {
  const s = String(text).replace(/^﻿/, "");
  const records = [];
  let record = [];
  let field = "";
  let inQuotes = false;
  let started = false; // any char seen for the current record?
  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
    started = false;
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
    } else if (ch === ",") {
      endField();
      started = true;
    } else if (ch === "\n") {
      endRecord();
    } else if (ch === "\r") {
      endRecord();
      if (s[i + 1] === "\n") i++;
    } else {
      field += ch;
      started = true;
    }
  }
  // A trailing field/record with content (no final newline) still counts.
  if (started || field !== "" || record.length) endRecord();
  return records;
}

// Which export this is, from its header columns. ManaBox owns `manaboxid`;
// Delver owns `foiletched`/`frametype`. The column that names the card also
// differs (`name` vs `cardname`), which is the last-resort tell.
function detectFormat(header) {
  const h = new Set(header);
  if (h.has("manaboxid")) return "manabox";
  if (h.has("foiletched") || h.has("frametype") || h.has("tcgplayersku")) {
    return "delver";
  }
  if (h.has("cardname")) return "delver";
  if (h.has("name") && h.has("setcode")) return "manabox";
  return null;
}

// Pull the fields this importer cares about out of one row, in whichever
// vocabulary the file uses, into ONE canonical shape the loop below reads.
function canonicalRow(format, row, line) {
  if (format === "delver") {
    return {
      line,
      name: row.cardname ?? "",
      setcode: row.setcode ?? "",
      collectornumber: row.number ?? "",
      scryfallid: row.scryfallid ?? "",
      foil: row.foiletched ?? "",
      quantity: row.quantity ?? "",
      // Delver does not export grade or language.
      condition: "",
      language: "",
    };
  }
  // manabox
  return {
    line,
    name: row.name ?? "",
    setcode: row.setcode ?? "",
    collectornumber: row.collectornumber ?? "",
    scryfallid: row.scryfallid ?? "",
    foil: row.foil ?? "",
    quantity: row.quantity ?? "",
    condition: row.condition ?? "",
    language: row.language ?? "",
  };
}

// The file as { format, entries } — entries in file order, each either
// { blank: true } (a pocket to skip) or a canonical row. `format` is null when
// the file is not a recognised export.
export function parseImportFile(text) {
  const records = parseCsvRecords(text);
  const isBlank = (rec) => rec.every((f) => f.trim() === "");

  // The header is the first record with content; leading blank lines are
  // structure, not pockets.
  let headerIndex = records.findIndex((rec) => !isBlank(rec));
  if (headerIndex === -1) return { format: null, entries: [] };
  const header = records[headerIndex].map(normalise);
  const format = detectFormat(header);
  if (!format) return { format: null, entries: [] };

  const entries = [];
  for (let i = headerIndex + 1; i < records.length; i++) {
    const rec = records[i];
    const line = i + 1;
    if (isBlank(rec)) {
      entries.push({ blank: true, line });
      continue;
    }
    const row = {};
    header.forEach((key, index) => {
      if (key) row[key] = (rec[index] ?? "").trim();
    });
    entries.push(canonicalRow(format, row, line));
  }
  // Trailing blank lines are the end of the file, not empty pockets.
  while (entries.length && entries[entries.length - 1].blank) entries.pop();
  return { format, entries };
}

// Ceilings on one import, so a single request cannot drive unbounded database
// work. A real scanned binder or exported collection is well within both.
const MAX_ROWS = 5000;
const MAX_ROW_QUANTITY = 100;

// Run the import. `unit` is the container, `collectionid` whose cards these
// become. Auto-detects the format. Returns a summary; never throws for a bad
// ROW — those are reported per line so one typo does not void a whole import.
export async function importCards(prisma, unit, collectionid, text) {
  const { format, entries } = parseImportFile(text);
  if (!format) {
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
  // blank — so the file's shape IS the binder's shape. The import continues the
  // binder rather than restarting it: counting begins after the LAST occupied
  // pocket. Bagged copies count as occupied — their pocket is spoken for until
  // the order resolves.
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

    // Clamp per-row quantity so a single huge number cannot drive billions of
    // sequential inserts. A real stack in one sleeve is a few dozen at most.
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
    // sequential by design. A multi-copy row stacks in its one pocket, the way
    // a scanned stack sits in the sleeve.
    for (let i = 0; i < quantity; i++) {
      const placement = await addPrintingCopy(prisma, unit, collectionid, {
        scryfallid: printing.scryfallid,
        conditionid,
        languageid,
        variant,
        // A sorted box appends: the file is in order, and each row going to the
        // front would file the whole import reversed.
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

  return { ok: true, format, added, skipped, errors };
}
