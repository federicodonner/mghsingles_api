// Reading a public Moxfield deck, for importing its cards into a wishlist.
//
// Moxfield has no official public API; their endpoints sit behind Cloudflare
// bot filtering that rejects curl outright but accepts Node's fetch with a
// browser User-Agent. That makes this integration best-effort by nature: if
// Moxfield tightens the door, the import degrades to an error message, never
// to anything worse. Only PUBLIC decks answer at all — a private deck is a
// 404 indistinguishable from a wrong id, and the error says so.
const DECK_URL = /moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json",
};

// The deck's public id out of whatever was pasted: the full URL, or the bare
// id itself. Null when neither shape fits.
export function moxfieldDeckId(input) {
  const text = String(input ?? "").trim();
  const match = text.match(DECK_URL);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{16,}$/.test(text) ? text : null;
}

// The deck's cards as [{ name, quantity }], one row per name, quantities
// summed across boards. Commanders, mainboard and sideboard count — those are
// the cards the deck actually needs; the maybeboard is thoughts, not wants.
export async function fetchMoxfieldDeck(deckId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(
      `https://api2.moxfield.com/v2/decks/all/${encodeURIComponent(deckId)}`,
      { headers: HEADERS, signal: controller.signal }
    );
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 404) return { status: 404, cards: null };
  if (!response.ok) return { status: response.status, cards: null };

  const deck = await response.json();
  const wanted = new Map();
  for (const board of ["commanders", "mainboard", "sideboard"]) {
    for (const [name, row] of Object.entries(deck[board] ?? {})) {
      const quantity = Number(row?.quantity) || 1;
      wanted.set(name, (wanted.get(name) ?? 0) + quantity);
    }
  }
  return {
    status: 200,
    cards: [...wanted].map(([name, quantity]) => ({ name, quantity })),
  };
}
