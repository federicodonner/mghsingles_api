// The condition and language a manually-added card gets.
//
// The shop decided (2026-08-23) not to SHOW condition and language for now:
// the UIs stopped asking, but the columns stay and keep being written, so the
// data is intact whenever the shop changes its mind — and a future ManaBox
// import will record the real values. A card added by hand is assumed to be
// near-mint English.
export const DEFAULT_CONDITION = "NM";
export const DEFAULT_LANGUAGE = "Inglés";

// The ids for the assumed identity. Looked up by name, not hard-coded ids —
// the seed happens to make both id 1, but nothing guarantees that elsewhere.
export async function defaultIdentity(db) {
  const [condition, language] = await Promise.all([
    db.cardcondition.findFirst({ where: { name: DEFAULT_CONDITION } }),
    db.cardlanguage.findFirst({ where: { name: DEFAULT_LANGUAGE } }),
  ]);
  return {
    conditionid: condition?.id ?? 1,
    languageid: language?.id ?? 1,
  };
}
