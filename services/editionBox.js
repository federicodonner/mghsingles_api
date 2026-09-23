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
import { compareEditionRow } from "./editionOrder.js";

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
