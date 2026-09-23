// The order the cards sit in an edition box.
//
// A leaf module on purpose: `storageContents` reads an edition box's copies in
// this order and `editionBox` builds the checklist in it, and those two already
// depend on each other's neighbours. Keeping the comparison here means neither
// has to import the other.

// Collector numbers are strings, and for good reason: "12a", "★7" and "A-23"
// are all real. Sorting them as text puts 10 before 2, and sorting them with
// parseInt throws away everything after the digits — so "12a" and "12b" land
// in an order that depends on which row the database happened to return first.
//
// Compare them in chunks instead: runs of digits numerically, everything else
// as text, and a chunk that starts with a digit always before one that does
// not — so the plain numbered cards come first and the ★-prefixed promos and
// lettered oddities trail them. "2" < "10" < "10a" < "10b" < "★2", which is
// the order the cards sit in the box.
export function compareCollectorNumber(a, b) {
  const chunks = (s) => String(s ?? "").match(/\d+|\D+/g) ?? [];
  const left = chunks(a);
  const right = chunks(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d/.test(x);
    const yNum = /^\d/.test(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    const diff = xNum
      ? parseInt(x, 10) - parseInt(y, 10)
      : x.localeCompare(y);
    if (diff) return diff;
  }
  return 0;
}

// Finishes in the order they are printed on the checklist: the plain card
// first, then its foil, then etched. Anything upstream adds later sorts after.
const FINISH_ORDER = { nonfoil: 0, foil: 1, etched: 2 };
export const compareFinish = (a, b) =>
  (FINISH_ORDER[a] ?? 9) - (FINISH_ORDER[b] ?? 9) || String(a).localeCompare(b);

// The whole ordering an edition box is read in, applied to anything carrying a
// collector number and a variant. Used both for the checklist and for the
// copies actually in the box, so the two always read in the same order.
export const compareEditionRow = (a, b) =>
  compareCollectorNumber(a.collectornumber, b.collectornumber) ||
  compareFinish(a.variant, b.variant);
