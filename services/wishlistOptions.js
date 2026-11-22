// Every option a wishlist entry for a given card name could accept.
//
// Since 2026-11-22 an entry's constraint lists are EXPLICIT: what is listed is
// exactly what is accepted, and a new entry starts with everything listed (the
// editor shows it all ticked). The old "empty list means any" rule read badly
// — a section with nothing ticked accepting everything — so empty lists are no
// longer written. The consequence, accepted on purpose: a printing released
// after the entry was created is NOT included automatically; the customer
// ticks it if they want it.
//
// Shared by every road that creates an entry (manual add, Moxfield import,
// store add), by the PUT that validates an edit, and by the backfill that
// converted the old empty lists.
import { FINISHES, finishesFor } from "./finishes.js";

// Languages and grades are shop-wide lookups; read them once per call site
// that handles many names (the import, the backfill) by passing `shared`.
export async function sharedOptions(prisma) {
  const [languages, conditions] = await Promise.all([
    prisma.cardlanguage.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
    prisma.cardcondition.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
  ]);
  return {
    languageids: languages.map((l) => l.id),
    conditionids: conditions.map((c) => c.id),
  };
}

// { versions, languageids, conditionids, variants } — all of them, for `name`.
// Versions are scryfallids in release order; variants are the finishes any
// printing of the card exists in, in the canonical FINISHES order.
export async function allOptions(prisma, name, shared = null) {
  const printings = await prisma.cardgeneral.findMany({
    where: { name: { equals: name, mode: "insensitive" } },
    select: { scryfallid: true, finishes: true },
    orderBy: [{ releasedatyear: "asc" }, { cardsetcode: "asc" }],
  });
  const finishes = new Set();
  for (const printing of printings) {
    for (const finish of finishesFor(printing)) finishes.add(finish);
  }
  return {
    versions: printings.map((p) => p.scryfallid),
    variants: FINISHES.filter((f) => finishes.has(f)),
    ...(shared ?? (await sharedOptions(prisma))),
  };
}

export const CATEGORIES = ["versions", "languageids", "conditionids", "variants"];

// Fill any empty category with every option — how an entry created without
// preferences (or an old "any" entry) becomes its explicit equivalent.
export function fillEmpty(lists, all) {
  const out = {};
  for (const key of CATEGORIES) {
    const list = lists[key] ?? [];
    out[key] = list.length ? list : all[key];
  }
  return out;
}

// Keep only values that are real options for this card, so a stored list can
// never carry ids or printings that do not exist.
export function onlyValid(list, valid) {
  const allowed = new Set(valid);
  return list.filter((v) => allowed.has(v));
}
