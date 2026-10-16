// The condition and language a card is recorded with.
//
// Whoever files a card grades it (2026-10-16 — before this only the shop did):
// staff in the back office and customers in their own containers both choose
// condition and language when they add or change a copy, and an import keeps
// what the file says. Anything not stated is near-mint English. The columns
// feed pricing's condition multipliers (services/pricing.js), and the
// storefront shows both to shoppers.
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

// The identity a request asks for: `conditionid` / `languageid` from the
// body where sent, `fallback` (default: NM English) where not. Returns null
// when an id was sent that names no row, so the route can answer 400 instead
// of tripping the foreign key.
export async function requestedIdentity(db, body, fallback = null) {
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
