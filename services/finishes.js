// Card finishes, using Scryfall's vocabulary verbatim.
//
// Scryfall records `finishes` per PRINTING — which of these a given printing
// was actually produced in — and half of all printings exist in only one:
// ~38% are nonfoil-only and ~12% are foil-only. So the finish a shop can record
// for a copy is not a free choice; it is constrained by the printing.
//
// The old code used an ad-hoc "normal" / "foil" / "foil-etched" vocabulary and
// wrote "" for non-foil in one place and "normal" in another. One word per
// concept now, matching upstream.
export const FINISHES = ["nonfoil", "foil", "etched"];

export const DEFAULT_FINISH = "nonfoil";

// Anything that is not plain nonfoil is some kind of foil. Used for the foil
// icon in the UIs and for the legacy boolean on `sale`.
export const isFoil = (finish) => Boolean(finish) && finish !== "nonfoil";

// A printing with no finishes recorded (3 exist upstream) should not be
// unusable, so fall back to nonfoil rather than to nothing.
export function finishesFor(cardgeneral) {
  const finishes = cardgeneral?.finishes ?? [];
  return finishes.length ? finishes : [DEFAULT_FINISH];
}
