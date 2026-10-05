// The condition and language a card is recorded with.
//
// Only the SHOP grades cards (2026-10-05): staff choose condition and language
// when they file a card, and an import run by staff keeps what the file says.
// A customer never states either — everything a customer adds or imports is
// recorded as near-mint English, and the customer app shows neither. The
// columns are still written on every row, so pricing can apply the condition
// multipliers (services/pricing.js).
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

// The identity a STAFF request asks for: `conditionid` / `languageid` from the
// body where sent, `fallback` (default: NM English) where not. Returns null
// when an id was sent that names no row, so the route can answer 400 instead
// of tripping the foreign key.
export async function staffIdentity(db, body, fallback = null) {
  const base = fallback ?? (await defaultIdentity(db));
  const sent = (value) => value !== undefined && value !== null && value !== "";
  let { conditionid, languageid } = base;
  if (sent(body?.conditionid)) {
    const id = parseInt(body.conditionid, 10);
    const row = Number.isInteger(id)
      ? await db.cardcondition.findUnique({ where: { id } })
      : null;
    if (!row) return null;
    conditionid = row.id;
  }
  if (sent(body?.languageid)) {
    const id = parseInt(body.languageid, 10);
    const row = Number.isInteger(id)
      ? await db.cardlanguage.findUnique({ where: { id } })
      : null;
    if (!row) return null;
    languageid = row.id;
  }
  return { conditionid, languageid };
}
