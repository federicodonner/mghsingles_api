// Exporting a container as a ManaBox CSV: the same columns the importer reads
// (services/collectionImport.js), so a file can go into ManaBox or come back
// into another container.
//
// One row per printing+finish+condition+language, with a Quantity — what a
// ManaBox collection export looks like. A binder's pockets do not survive
// that: rows follow the binder's order, but two copies of a card in different
// pockets are one row.
//
// What the shop has no value for is left empty rather than invented: the
// ManaBox ID is ManaBox's own, and a purchase price is what somebody paid,
// which the shop's market prices are not.
import { CARD_INCLUDE } from "./storageContents.js";
import { editionComparator } from "./editionOrder.js";

const HEADER = [
  "Name",
  "Set code",
  "Set name",
  "Collector number",
  "Foil",
  "Rarity",
  "Quantity",
  "ManaBox ID",
  "Scryfall ID",
  "Purchase price",
  "Misprint",
  "Altered",
  "Condition",
  "Language",
  "Purchase currency",
];

// The shop's grades onto ManaBox's scale, the reverse of the importer's maps.
const CONDITIONS = {
  NM: "near_mint",
  EX: "excellent",
  VG: "good",
  G: "played",
  damaged: "poor",
};
const LANGUAGES = {
  Inglés: "en",
  Español: "es",
  Francés: "fr",
  Portugués: "pt",
  Alemán: "de",
  Japonés: "ja",
  Chino: "zh_CN",
  Ruso: "ru",
};

const FINISHES = { nonfoil: "normal" };

// Quoted only when it has to be: card names carry commas and double quotes.
const csvField = (value) => {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

// The order each type of container is read in; anything else, by arrival.
// Stand-by copies of a binder have no page, so they go after its pockets.
const PLACEMENT_ORDER = {
  binder: [
    { page: { sort: "asc", nulls: "last" } },
    { pocket: { sort: "asc", nulls: "last" } },
    { depth: { sort: "asc", nulls: "last" } },
    { id: "asc" },
  ],
  sorted_box: [{ sequence: "asc" }],
};

// The container's contents as CSV text. Copies bagged for an order are left
// out, like everywhere else that says what is physically in the container.
export async function exportCards(prisma, unit) {
  const placements = await prisma.cardplacement.findMany({
    where: { storageid: unit.id, orderlineid: null },
    include: CARD_INCLUDE,
    orderBy: PLACEMENT_ORDER[unit.type] ?? { id: "asc" },
  });

  // A Map, so rows keep the order their first copy was read in.
  const rows = new Map();
  for (const { card } of placements) {
    const printing = card?.cardgeneral;
    if (!printing) continue;
    const condition = card.cardcondition?.name;
    const language = card.cardlanguage?.name;
    const key = [card.scryfallid, card.variant, condition, language].join("|");
    if (rows.has(key)) {
      rows.get(key).quantity++;
      continue;
    }
    rows.set(key, {
      ...printing,
      variant: card.variant,
      condition,
      language,
      quantity: 1,
    });
  }

  const ordered = [...rows.values()];
  if (unit.type === "edition_box") {
    ordered.sort(editionComparator(unit.editionorder));
  }

  const lines = ordered.map((row) => [
    row.name,
    row.cardsetcode,
    row.cardsetname,
    row.collectornumber,
    FINISHES[row.variant] ?? row.variant,
    row.rarity,
    row.quantity,
    "",
    row.scryfallid,
    "",
    "false",
    "false",
    CONDITIONS[row.condition] ?? CONDITIONS.NM,
    LANGUAGES[row.language] ?? LANGUAGES.Inglés,
    "",
  ]);
  return [HEADER, ...lines]
    .map((line) => line.map(csvField).join(","))
    .join("\n")
    .concat("\n");
}
