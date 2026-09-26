// An edition box: one set, laid out as that set's checklist.
//
// Every other container is a list of the copies that happen to be in it. An
// edition box is the opposite — it is the SET, printed out: every paper
// printing the set has, in collector-number order, each finish on its own
// line, and a quantity beside it that starts at zero. The shop does not add
// and remove cards one at a time here; it says "I have three of this one",
// which is how somebody actually fills a set box.
//
// So the checklist is DERIVED from `cardgeneral` and never stored. What is
// stored is the same thing every container stores: one `cardplacement` per
// physical copy. A quantity of three is three placements — nothing about
// selling, pricing, reserving or refiling has to learn a new shape.
//
// Shop-owned only, and that is the route's rule to enforce; nothing here
// decides who may call it.
import messages from "../data/messages.js";
import { ContentsError } from "./storageContents.js";
import { PAPER_ONLY, isPaperPrinting } from "./paper.js";
import { finishesFor } from "./finishes.js";
import { defaultIdentity } from "./identity.js";
import { addPrintingCopy, removeCopy } from "./copies.js";
import { compareEditionRow, compareCollectorNumber } from "./editionOrder.js";
import {
  parseImportFile,
  MAX_ROWS,
  MAX_ROW_QUANTITY,
  FINISH_MAP,
  normalise,
} from "./collectionImport.js";

// The most copies of one printing+finish an edition box will record.
//
// A set box holds a few of each card, not a case of them. The cap exists
// because a quantity is turned into that many rows in one request: without it
// a typed-in 100000 would be a hundred thousand inserts.
export const MAX_EDITION_QUANTITY = 99;

// How many copies of each printing+finish this container holds, keyed
// "<scryfallid>|<variant>".
//
// Bagged copies are counted SEPARATELY, not folded into the quantity: a copy
// promised to a buyer is physically in a bag on the counter, so the shop
// counting the box will not find it. Showing it as present would make every
// count come up short and invite somebody to "correct" it.
export async function tallyContainer(prisma, storageId) {
  const placements = await prisma.cardplacement.findMany({
    where: { storageid: storageId },
    select: {
      id: true,
      orderlineid: true,
      card: { select: { scryfallid: true, variant: true } },
    },
    orderBy: { id: "asc" },
  });

  const here = new Map();
  const bagged = new Map();
  for (const pl of placements) {
    if (!pl.card?.scryfallid) continue;
    const key = `${pl.card.scryfallid}|${pl.card.variant}`;
    const into = pl.orderlineid === null ? here : bagged;
    into.set(key, (into.get(key) ?? 0) + 1);
  }
  return { here, bagged };
}

// The checklist: every paper printing in the box's set, every finish it was
// made in, with what the shop has of each.
//
// Rows with a quantity of zero are included — they are the point. The box is a
// set to be completed, and a card the shop has none of is exactly the row
// somebody wants to see when they are looking for what is missing.
export async function readEditionRows(prisma, unit) {
  if (unit.type !== "edition_box" || !unit.cardsetcode) {
    throw new ContentsError(messages.STORAGE_NOT_EDITION);
  }

  const [printings, set, tally] = await Promise.all([
    prisma.cardgeneral.findMany({
      where: { cardsetcode: unit.cardsetcode, ...PAPER_ONLY },
      select: {
        scryfallid: true,
        name: true,
        collectornumber: true,
        image: true,
        rarity: true,
        finishes: true,
      },
    }),
    prisma.cardset.findUnique({ where: { cardset: unit.cardsetcode } }),
    tallyContainer(prisma, unit.id),
  ]);

  const rows = [];
  for (const printing of printings) {
    for (const variant of finishesFor(printing)) {
      const key = `${printing.scryfallid}|${variant}`;
      rows.push({
        scryfallid: printing.scryfallid,
        name: printing.name,
        collectornumber: printing.collectornumber,
        image: printing.image,
        rarity: printing.rarity,
        variant,
        quantity: tally.here.get(key) ?? 0,
        bagged: tally.bagged.get(key) ?? 0,
      });
    }
  }
  rows.sort(compareEditionRow);

  return {
    cardsetcode: unit.cardsetcode,
    cardsetname: set?.cardsetname ?? unit.cardsetcode,
    rows,
    // What the shop has in the box, and how much of the set that covers —
    // the two numbers a set box is actually judged by.
    total: rows.reduce((sum, row) => sum + row.quantity, 0),
    distinct: rows.filter((row) => row.quantity > 0).length,
    slots: rows.length,
  };
}

// Set how many copies of one printing+finish the box holds.
//
// The difference is what happens, not the number: asking for three when there
// are two adds one copy, asking for one removes one. Nothing is deleted and
// recreated, so the copies that stay keep their identity — and their prices,
// their condition and their place in any open order.
//
// Copies are removed NEWEST first. The oldest copy of a card is the one most
// likely to be the one an earlier flow already knows about; taking the most
// recently added one back is the undo of the click that added it. Bagged
// copies are never touched: they are not in the box, so they are not the
// shop's to count down.
export async function setEditionQuantity(
  prisma,
  unit,
  collectionid,
  { scryfallid, variant, quantity }
) {
  if (unit.type !== "edition_box" || !unit.cardsetcode) {
    throw new ContentsError(messages.STORAGE_NOT_EDITION);
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new ContentsError(messages.PARAMETERS_ERROR);
  }
  if (quantity > MAX_EDITION_QUANTITY) {
    throw new ContentsError(messages.EDITION_QUANTITY_TOO_HIGH);
  }

  const printing = await prisma.cardgeneral.findUnique({
    where: { scryfallid: String(scryfallid ?? "") },
  });
  if (!printing) {
    throw new ContentsError(messages.CARD_NOT_FOUND, 404);
  }
  // The box IS the set. A printing from anywhere else does not belong in it,
  // whatever the caller says.
  if (printing.cardsetcode !== unit.cardsetcode) {
    throw new ContentsError(messages.EDITION_WRONG_SET);
  }
  if (!isPaperPrinting(printing)) {
    throw new ContentsError(messages.CARD_DIGITAL_ONLY);
  }
  const finishes = finishesFor(printing);
  if (!finishes.includes(variant)) {
    throw new ContentsError(messages.FINISH_NOT_AVAILABLE);
  }

  // The copies of this printing+finish that are actually in the box, newest
  // last. Bagged ones are excluded here, not filtered later, so they can
  // neither be counted nor removed.
  const present = await prisma.cardplacement.findMany({
    where: {
      storageid: unit.id,
      orderlineid: null,
      card: { scryfallid: printing.scryfallid, variant },
    },
    include: { storage: { select: { type: true } } },
    orderBy: { id: "asc" },
  });

  if (quantity > present.length) {
    const assumed = await defaultIdentity(prisma);
    for (let i = present.length; i < quantity; i++) {
      await addPrintingCopy(prisma, unit, collectionid, {
        scryfallid: printing.scryfallid,
        variant,
        conditionid: assumed.conditionid,
        languageid: assumed.languageid,
      });
    }
  } else if (quantity < present.length) {
    for (const placement of present.slice(quantity).reverse()) {
      await removeCopy(prisma, placement);
    }
  }

  return { scryfallid: printing.scryfallid, variant, quantity };
}

// A card name as the import compares it: case, accents and spacing do not
// make two cards different. "Æther" and "Aether" are the same card to anyone
// typing it, and an export app's spelling is not the shop's to argue with.
const nameKey = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/gi, "ae")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Import a ManaBox or Delver export into an edition box.
//
// The box is its set, so every row is read as "a card of THIS set" — but as
// precisely as the file allows:
//
//   1. The row's own printing (Scryfall id, else set code + collector number)
//      when it is one of this set's — a showcase, an etched, a promo number is
//      filed exactly as scanned.
//   2. Otherwise the row's card NAME within the set. Scanners misread the set
//      symbol all the time; a card the set has is the card the shop meant,
//      whatever edition the app guessed.
//
// Either way the file's finish is kept when the set has the card in it: a
// foil lands on the foil line, and where the foil or etched version is its own
// printing (etched usually is), the name search picks the printing that offers
// it. Only when the set has no such finish for the card does it fall back to
// the plain one — or, for an exactly-scanned printing, to that printing's own
// finish.
//
// Rows landing on the same printing+finish add up — "2x A" and later "1x A" is
// three copies of A. A name the set does not have is not a failure of the
// file: the rest is imported and that card is reported, with why, so the shop
// can deal with it by hand. Nothing here throws for a row.
export async function importEditionBox(prisma, unit, collectionid, text) {
  if (unit.type !== "edition_box" || !unit.cardsetcode) {
    throw new ContentsError(messages.STORAGE_NOT_EDITION);
  }
  const { format, entries } = parseImportFile(text);
  if (!format) {
    return { ok: false, added: 0, errors: [], badFile: true };
  }
  if (entries.length > MAX_ROWS) {
    return { ok: false, added: 0, errors: [], tooLarge: true };
  }

  // The set's paper printings, in checklist order, indexed three ways: by
  // Scryfall id and collector number for exact rows, and by name — every
  // printing of it, in order — for the rest. A double-faced card is also found
  // by its front face alone, which is how some exports write it.
  const printings = await prisma.cardgeneral.findMany({
    where: { cardsetcode: unit.cardsetcode, ...PAPER_ONLY },
    select: { scryfallid: true, name: true, collectornumber: true, finishes: true },
  });
  printings.sort((a, b) =>
    compareCollectorNumber(a.collectornumber, b.collectornumber)
  );
  const byId = new Map(printings.map((p) => [p.scryfallid, p]));
  const byNumber = new Map(
    printings.map((p) => [String(p.collectornumber ?? "").toLowerCase(), p])
  );
  const byName = new Map();
  for (const printing of printings) {
    const full = nameKey(printing.name);
    const front = nameKey(printing.name.split("//")[0]);
    for (const key of new Set([full, front])) {
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(printing);
    }
  }
  const setcode = unit.cardsetcode.toLowerCase();

  // The printing+finish one row lands on, or null when the set lacks the card.
  const resolve = (entry) => {
    const finish = FINISH_MAP[normalise(entry.foil ?? "")] ?? "nonfoil";
    const offers = (p) => finishesFor(p).includes(finish);
    const plain = (p) => {
      const finishes = finishesFor(p);
      return finishes.includes("nonfoil") ? "nonfoil" : finishes[0];
    };

    let exact = entry.scryfallid ? byId.get(entry.scryfallid) : null;
    if (
      !exact &&
      String(entry.setcode ?? "").toLowerCase() === setcode &&
      entry.collectornumber
    ) {
      exact = byNumber.get(String(entry.collectornumber).toLowerCase());
    }
    // A scanned printing of this set is trusted over everything else in the
    // row: if the file's finish contradicts it (a "normal" flag on a
    // foil-only borderless), the printing is the stronger evidence.
    if (exact) {
      return { printing: exact, variant: offers(exact) ? finish : plain(exact) };
    }
    // By name: the first printing that comes in the file's finish, else the
    // first printing in its plain finish.
    const candidates = byName.get(nameKey(entry.name)) ?? [];
    const withFinish = candidates.find(offers);
    if (withFinish) return { printing: withFinish, variant: finish };
    const first = candidates[0];
    return first ? { printing: first, variant: plain(first) } : null;
  };

  // Sum the file by the printing+finish each row resolves to — not by its
  // text, since "Delver of Secrets" and "Delver of Secrets // Insectile
  // Aberration" are one card. Names the set lacks are summed too, so the
  // report says each missing card once, with its total.
  const wanted = new Map();
  const missing = new Map();
  const errors = [];
  for (const entry of entries) {
    if (entry.blank) continue;
    if (!nameKey(entry.name) && !entry.scryfallid) {
      errors.push({ line: entry.line, name: null, reason: "no_name" });
      continue;
    }
    const quantity = Math.min(
      MAX_ROW_QUANTITY,
      Math.max(1, parseInt(entry.quantity, 10) || 1)
    );
    const hit = resolve(entry);
    const into = hit ? wanted : missing;
    const id = hit
      ? `${hit.printing.scryfallid}|${hit.variant}`
      : nameKey(entry.name) || entry.scryfallid;
    const seen = into.get(id);
    if (seen) seen.quantity += quantity;
    else
      into.set(id, {
        name: hit?.printing.name ?? (entry.name || entry.scryfallid),
        ...hit,
        quantity,
      });
  }
  for (const { name, quantity } of missing.values()) {
    errors.push({ name, quantity, reason: "not_in_edition" });
  }

  const { here } = await tallyContainer(prisma, unit.id);

  let added = 0;
  for (const [key, { name, printing, variant, quantity }] of wanted) {
    const present = here.get(key) ?? 0;
    const fits = Math.max(0, Math.min(quantity, MAX_EDITION_QUANTITY - present));
    if (fits > 0) {
      await setEditionQuantity(prisma, unit, collectionid, {
        scryfallid: printing.scryfallid,
        variant,
        quantity: present + fits,
      });
      added += fits;
    }
    if (fits < quantity) {
      errors.push({ name, quantity: quantity - fits, reason: "quantity_too_high" });
    }
  }

  return { ok: true, format, added, cards: wanted.size, errors };
}
