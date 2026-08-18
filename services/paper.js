// The shop sells cardboard.
//
// Scryfall classifies every printing by where it exists — `games` is some
// subset of paper / mtgo / arena — and roughly 8% of the bulk file is
// digital-only: Alchemy rebalances, Arena-only promos, MTGO treasure-chest
// printings. None of those can be graded, filed in a binder or handed across a
// counter, so none of them belong in the catalogue.
//
// The importer already refuses to write a non-paper row
// (scripts/syncScryfall.mjs) and purges any that an earlier run wrote. This
// module is the same rule stated at the API boundary, for two reasons: a
// database restored from an older dump would otherwise quietly reintroduce
// them, and a rule enforced only by an overnight job is a rule nobody can see
// while reading a route.
//
// `games` is null on rows written before the column existed. Those are treated
// as paper rather than hidden: they predate the distinction, the overwhelming
// majority of them are paper, and blanking the catalogue for anyone who has not
// re-run the sync yet would be a worse failure than letting a stale row through
// until the next nightly run removes it.

// Spread into a Prisma `where` on cardgeneral.
export const PAPER_ONLY = {
  OR: [{ games: { has: "paper" } }, { games: { isEmpty: true } }],
};

// The same test against a row already loaded.
export function isPaperPrinting(printing) {
  const games = printing?.games;
  if (!games || games.length === 0) return true; // predates the column
  return games.includes("paper");
}

// Sets that exist only on Arena or MTGO. Filtered where a human picks a set —
// after the purge such a set has no cards at all, so it can only ever be an
// empty option in a dropdown.
export const PAPER_SETS_ONLY = { digital: false };
