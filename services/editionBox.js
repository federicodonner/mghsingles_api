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
import { addPrintingCopy, removeCopy, changePrintingCopy } from "./copies.js";
import { compareEditionRow, compareCollectorNumber } from "./editionOrder.js";
import {
  parseImportFile,
  MAX_ROWS,
  MAX_ROW_QUANTITY,
  FINISH_MAP,
  normalise,
  gradeResolver,
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
//
// `grades` breaks the copies in the box down by condition+language, keyed
// like `here`, each value a Map "<conditionid>|<languageid>" -> count. Every
// grade is in it, near-mint English included; the checklist decides what to
// show.
export async function tallyContainer(prisma, storageId) {
  const placements = await prisma.cardplacement.findMany({
    where: { storageid: storageId },
    select: {
      id: true,
      orderlineid: true,
      card: {
        select: {
          scryfallid: true,
          variant: true,
          conditionid: true,
          languageid: true,
        },
      },
    },
    orderBy: { id: "asc" },
  });

  const here = new Map();
  const bagged = new Map();
  const grades = new Map();
  for (const pl of placements) {
    if (!pl.card?.scryfallid) continue;
    const key = `${pl.card.scryfallid}|${pl.card.variant}`;
    const into = pl.orderlineid === null ? here : bagged;
    into.set(key, (into.get(key) ?? 0) + 1);
    if (pl.orderlineid !== null) continue;
    if (!grades.has(key)) grades.set(key, new Map());
    const byGrade = grades.get(key);
    const gradeKey = `${pl.card.conditionid}|${pl.card.languageid}`;
    byGrade.set(gradeKey, (byGrade.get(gradeKey) ?? 0) + 1);
  }
  return { here, bagged, grades };
}

const gradeKeyOf = ({ conditionid, languageid }) => `${conditionid}|${languageid}`;

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

  const [printings, set, tally, conditions, languages, assumed] = await Promise.all([
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
    prisma.cardcondition.findMany(),
    prisma.cardlanguage.findMany(),
    defaultIdentity(prisma),
  ]);
  const conditionName = new Map(conditions.map((c) => [c.id, c.name]));
  const languageName = new Map(languages.map((l) => [l.id, l.name]));
  const defaultKey = gradeKeyOf(assumed);

  // The copies that are NOT near-mint English — the row's variations, each
  // counted on its own and on top of the row's near-mint English copies
  // (`plain`).
  const variationsOf = (key) =>
    [...(tally.grades.get(key) ?? new Map())]
      .filter(([gradeKey]) => gradeKey !== defaultKey)
      .map(([gradeKey, quantity]) => {
        const [conditionid, languageid] = gradeKey.split("|").map(Number);
        return {
          conditionid,
          languageid,
          condition: conditionName.get(conditionid) ?? null,
          language: languageName.get(languageid) ?? null,
          quantity,
        };
      })
      .sort((a, b) => a.conditionid - b.conditionid || a.languageid - b.languageid);

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
        // Every copy in the box, whatever its grade: what the box's progress
        // and totals count.
        quantity: tally.here.get(key) ?? 0,
        // The near-mint English ones — the number the row's own counter edits.
        plain: tally.grades.get(key)?.get(defaultKey) ?? 0,
        bagged: tally.bagged.get(key) ?? 0,
        grades: variationsOf(key),
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

// The printing+finish an edition-box request names, checked against the box:
// it must be one of the box's set, on paper, in a finish it was printed in.
async function editionPrinting(prisma, unit, scryfallid, variant) {
  if (unit.type !== "edition_box" || !unit.cardsetcode) {
    throw new ContentsError(messages.STORAGE_NOT_EDITION);
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
  if (!finishesFor(printing).includes(variant)) {
    throw new ContentsError(messages.FINISH_NOT_AVAILABLE);
  }
  return printing;
}

// The copies of one printing+finish that are actually in the box, oldest
// first, each with its grade. Bagged ones are excluded here, not filtered
// later, so they can neither be counted, removed nor regraded.
function copiesInBox(prisma, unit, scryfallid, variant) {
  return prisma.cardplacement.findMany({
    where: {
      storageid: unit.id,
      orderlineid: null,
      card: { scryfallid, variant },
    },
    include: {
      storage: { select: { type: true } },
      card: { select: { conditionid: true, languageid: true } },
    },
    orderBy: { id: "asc" },
  });
}

const isGrade = (placement, grade) =>
  placement.card.conditionid === grade.conditionid &&
  placement.card.languageid === grade.languageid;

// Setting a count adds or removes copies of ONE grade; copies in other grades
// are never touched. The difference is what happens, not the number: asking
// for three when there are two adds one copy, asking for one removes one.
// Nothing is deleted and recreated, so the copies that stay keep their
// identity — and their prices and their place in any open order.
//
// Copies are removed NEWEST first: the undo of the click that added them.
// Bagged copies are never touched: they are not in the box, so they are not
// the shop's to count down.
//
// The cap is on the row's TOTAL, every grade together — the box holds a few
// of each card, not a case of them, and a quantity becomes that many inserts.
async function setGradeCount(prisma, unit, collectionid, printing, variant, grade, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new ContentsError(messages.PARAMETERS_ERROR);
  }
  const present = await copiesInBox(prisma, unit, printing.scryfallid, variant);
  const mine = present.filter((pl) => isGrade(pl, grade));
  if (present.length - mine.length + quantity > MAX_EDITION_QUANTITY) {
    throw new ContentsError(messages.EDITION_QUANTITY_TOO_HIGH);
  }
  for (let i = mine.length; i < quantity; i++) {
    await addPrintingCopy(prisma, unit, collectionid, {
      scryfallid: printing.scryfallid,
      variant,
      ...grade,
    });
  }
  for (const placement of mine.slice(quantity).reverse()) {
    await removeCopy(prisma, placement);
  }
}

// Set how many NEAR-MINT ENGLISH copies of one printing+finish the box holds
// — the row's own counter. Variations (setEditionGrade) are counted on top of
// it, not out of it: four here plus two Japanese is six copies.
export async function setEditionQuantity(
  prisma,
  unit,
  collectionid,
  { scryfallid, variant, quantity }
) {
  const printing = await editionPrinting(prisma, unit, scryfallid, variant);
  const assumed = await defaultIdentity(prisma);
  await setGradeCount(prisma, unit, collectionid, printing, variant, assumed, quantity);
  return { scryfallid: printing.scryfallid, variant, quantity };
}

// Set how many copies of one printing+finish the box holds in one condition+
// language other than near-mint English — a variation. It adds to the row's
// near-mint English copies; it is not a share of them.
//
// `from` (optional, a { conditionid, languageid }) re-labels an existing
// variation first: every copy in that grade moves to the new one — "it was
// Spanish, not Japanese" — and then the quantity applies. Re-labelling onto
// near-mint English folds the copies into the row's own count.
export async function setEditionGrade(
  prisma,
  unit,
  collectionid,
  { scryfallid, variant, conditionid, languageid, quantity, from = null }
) {
  const printing = await editionPrinting(prisma, unit, scryfallid, variant);
  const [condition, language] = await Promise.all([
    Number.isInteger(conditionid)
      ? prisma.cardcondition.findUnique({ where: { id: conditionid } })
      : null,
    Number.isInteger(languageid)
      ? prisma.cardlanguage.findUnique({ where: { id: languageid } })
      : null,
  ]);
  if (!condition || !language) {
    throw new ContentsError(messages.PARAMETERS_ERROR);
  }
  const grade = { conditionid, languageid };
  const assumed = await defaultIdentity(prisma);

  if (from && !isGrade({ card: from }, grade)) {
    const present = await copiesInBox(prisma, unit, printing.scryfallid, variant);
    for (const placement of present.filter((pl) => isGrade(pl, from))) {
      await changePrintingCopy(prisma, placement, {
        scryfallid: printing.scryfallid,
        variant,
        ...grade,
      });
    }
  }

  if (isGrade({ card: grade }, assumed)) {
    // Near-mint English is the row's own counter, not a variation. Reaching
    // here with `from` was a variation folding into it, which is done.
    if (from) return { scryfallid: printing.scryfallid, variant, ...grade };
    throw new ContentsError(messages.EDITION_GRADE_IS_DEFAULT);
  }

  await setGradeCount(prisma, unit, collectionid, printing, variant, grade, quantity);
  return { scryfallid: printing.scryfallid, variant, ...grade, quantity };
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
  const gradeOf = await gradeResolver(prisma);
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
    let seen = into.get(id);
    if (seen) seen.quantity += quantity;
    else {
      seen = {
        name: hit?.printing.name ?? (entry.name || entry.scryfallid),
        ...hit,
        quantity,
        // How many of them in each condition+language, in file order.
        grades: new Map(),
      };
      into.set(id, seen);
    }
    if (hit) {
      const grade = gradeOf(entry);
      const gradeKey = `${grade.conditionid}|${grade.languageid}`;
      const tally = seen.grades.get(gradeKey);
      if (tally) tally.quantity += quantity;
      else seen.grades.set(gradeKey, { ...grade, quantity });
    }
  }
  for (const { name, quantity } of missing.values()) {
    errors.push({ name, quantity, reason: "not_in_edition" });
  }

  const { here } = await tallyContainer(prisma, unit.id);

  let added = 0;
  for (const [key, { name, printing, variant, quantity, grades }] of wanted) {
    const present = here.get(key) ?? 0;
    const fits = Math.max(0, Math.min(quantity, MAX_EDITION_QUANTITY - present));
    // Copies are added one at a time in the grade the file gave them. (The
    // checklist's own quantity field, setEditionQuantity, files NM English.)
    let room = fits;
    for (const grade of grades.values()) {
      for (let i = 0; i < grade.quantity && room > 0; i++, room--) {
        await addPrintingCopy(prisma, unit, collectionid, {
          scryfallid: printing.scryfallid,
          variant,
          conditionid: grade.conditionid,
          languageid: grade.languageid,
        });
        added++;
      }
    }
    if (fits < quantity) {
      errors.push({ name, quantity: quantity - fits, reason: "quantity_too_high" });
    }
  }

  return { ok: true, format, added, cards: wanted.size, errors };
}
