#!/usr/bin/env node
// Build a rich LOCAL dataset to click around in.
//
//   npm run seed:dev
//
// Wipes and rebuilds everything that describes the shop's day-to-day: people,
// consigned stock, containers in every lifecycle state, orders in every status,
// wishlists with real constraints, sales history and payouts. It does NOT touch
// the reference tables — cardgeneral, cardprice, cardcondition, cardlanguage —
// because those come from the Scryfall and MTGJSON imports and take a long time
// to rebuild. Run those first if the database is empty.
//
// Everything is derived from real printings already in `cardgeneral`, so the
// stock has real names, real set codes, real images and real CardKingdom
// reference prices. Prices are set through services/pricing.js rather than made
// up, so the condition multipliers visibly hold.
//
// REFUSES to run against a non-local database. This deletes people's orders.
import { PrismaClient } from "@prisma/client";
import { hash } from "bcrypt";
import { applyReferencePrices } from "../services/pricing.js";

const prisma = new PrismaClient();
const now = Math.round(Date.now() / 1000);
const DAY = 86400;

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL ?? "";
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.startsWith("postgresql:///");
if (!isLocal && !process.argv.includes("--i-know-what-i-am-doing")) {
  console.error(
    "DATABASE_URL does not look local. This script deletes orders, sales and\n" +
      "storage. Refusing to run.\n" +
      `  DATABASE_URL = ${url.replace(/:[^:@/]*@/, ":***@")}`
  );
  process.exit(1);
}

const log = (msg) => process.stdout.write(`${msg}\n`);

// ---------------------------------------------------------------------------
// The cast
// ---------------------------------------------------------------------------

// One password rule for everybody, so the credentials table is short: the
// username followed by 1234. Fine for a throwaway local database, and nowhere
// near production.
const PEOPLE = [
  { username: "fede", name: "Fede Donner", role: "owner", percent: null },
  { username: "lucia", name: "Lucía Ferrari", role: "staff", percent: null },
  { username: "ana", name: "Ana Rodríguez", role: "customer", percent: 0.3 },
  { username: "martin", name: "Martín Silva", role: "customer", percent: 0.25 },
  { username: "sofia", name: "Sofía Méndez", role: "customer", percent: 0.3 },
  { username: "diego", name: "Diego Pereyra", role: "customer", percent: 0.35 },
];
const password = (username) => `${username}1234`;

// Cards to stock, by name. Picked to be recognisable and to span rarities,
// eras and finishes — the exact printing is resolved from cardgeneral below.
const WANTED = [
  "Lightning Bolt", "Counterspell", "Dark Ritual", "Llanowar Elves",
  "Swords to Plowshares", "Brainstorm", "Sol Ring", "Birds of Paradise",
  "Path to Exile", "Thoughtseize", "Snapcaster Mage", "Tarmogoyf",
  "Force of Will", "Cyclonic Rift", "Rhystic Study", "Smothering Tithe",
  "Mana Crypt", "Demonic Tutor", "Wrath of God", "Serra Angel",
  "Shivan Dragon", "Giant Growth", "Ancestral Recall", "Black Lotus",
  "Ponder", "Preordain", "Fatal Push", "Lotus Petal",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Deterministic pseudo-randomness: the same seed produces the same shop every
// time, so a bug found by clicking around can be reproduced.
let seed = 20260817;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const pickInt = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

async function wipe() {
  // Order matters: children before parents. cardplacement points at both
  // orderline and storage, so it goes first.
  await prisma.cardplacement.deleteMany({});
  await prisma.wishlistmatch.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.orderline.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.wishlist.deleteMany({});
  await prisma.storage.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.sale.deleteMany({});
  await prisma.card.deleteMany({});
  await prisma.collection.deleteMany({});
  await prisma.login.deleteMany({});
  await prisma.player.deleteMany({});
  log("wiped transactional data (reference tables untouched)");
}

async function makePeople() {
  const people = {};
  for (const person of PEOPLE) {
    const player = await prisma.player.create({
      data: {
        username: person.username,
        name: person.name,
        email: `${person.username}@example.com`,
        role: person.role,
        passwordhash: await hash(password(person.username), 8),
      },
    });
    // Staff and the owner get a collection too — they consign like anyone else,
    // and /sale and /admin/pendingpayments assume every player has one.
    const collection = await prisma.collection.create({
      data: {
        playerid: player.id,
        percent: person.percent ?? 0.3,
        name: person.role === "customer" ? "Colección" : "Personal",
        active: true,
      },
    });
    people[person.username] = { player, collection, role: person.role };
  }
  log(`${PEOPLE.length} players, each with a collection`);
  return people;
}

// Resolve the wanted names to real printings, preferring ones that carry a
// CardKingdom reference price so the pricing rules have something to work on.
async function resolvePrintings() {
  const rows = await prisma.cardgeneral.findMany({
    where: { name: { in: WANTED }, image: { not: null } },
    include: { cardprice: { where: { source: "cardkingdom" } } },
  });

  const byName = new Map();
  for (const row of rows) {
    const key = row.name;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }
  // Prefer a printing that has a price; fall back to any printing.
  const chosen = [];
  for (const [name, printings] of byName) {
    const priced = printings.filter((p) => p.cardprice.length);
    const pool = priced.length ? priced : printings;
    // Two printings of the same card where possible, so the version picker has
    // something to pick between.
    chosen.push(pool[0]);
    if (pool.length > 1) chosen.push(pool[Math.min(1, pool.length - 1)]);
    if (!byName.has(name)) continue;
  }
  log(`${chosen.length} printings resolved from ${byName.size} distinct cards`);
  return chosen;
}

// Spread stock across the consignors, with a realistic mix of conditions,
// languages and finishes. A card's finish must be one the printing actually
// exists in — that is the whole point of cardgeneral.finishes.
async function makeStock(people, printings) {
  const consignors = ["ana", "martin", "sofia", "diego", "fede"];
  const cards = [];

  for (const printing of printings) {
    const owner = people[pick(consignors)];
    const finish = pick(printing.finishes.length ? printing.finishes : ["nonfoil"]);
    // Weighted towards NM/EX: most stock a shop takes in is playable.
    const conditionid = pick([1, 1, 1, 2, 2, 3, 4]);
    const languageid = pick([1, 1, 1, 1, 2, 2, 6]);

    const card = await prisma.card.create({
      data: {
        collectionid: owner.collection.id,
        scryfallid: printing.scryfallid,
        quantity: pickInt(1, 4),
        conditionid,
        languageid,
        variant: finish,
        approved: true,
      },
    });
    cards.push(card);
  }
  log(`${cards.length} card rows across ${consignors.length} collections`);
  return cards;
}

// Price everything off the CardKingdom reference through the real pricing
// service, so the condition multipliers are visibly applied rather than faked.
async function priceStock() {
  const result = await applyReferencePrices(prisma);
  log(
    `priced ${result.sell} sell / ${result.buy} buy of ${result.considered} cards ` +
      `(${result.noReference} had no CardKingdom reference)`
  );

  // One card deliberately priced by hand and locked, so the "don't touch this"
  // rule has something to demonstrate on the Precios page — and so re-running
  // the price import visibly leaves it alone.
  const locked = await prisma.card.findFirst({
    where: { cardgeneral: { name: "Sol Ring" } },
    include: { cardgeneral: { select: { name: true } } },
  });
  if (locked) {
    await prisma.card.update({
      where: { id: locked.id },
      data: { price: "99.99", pricelocked: true, priceupdate: now },
    });
    log(`  card ${locked.id} ("${locked.cardgeneral.name}") pinned at 99.99, pricelocked`);
  }
}

// Containers covering every lifecycle state, plus the shop's own.
async function makeStorage(people) {
  const mk = (name, type, owner, state) =>
    prisma.storage.create({
      data: { name, type, playerid: owner ? people[owner].player.id : null, state },
    });

  const units = {
    vitrina: await mk("Vitrina principal", "binder", null, "for_sale"),
    ordenada: await mk("Caja ordenada A-M", "sorted_box", null, "for_sale"),
    commons: await mk("Caja de commons", "unsorted_box", null, "for_sale"),

    // Ana consigns actively: both her containers are selling.
    anaBinder: await mk("Carpeta de Ana", "binder", "ana", "for_sale"),
    anaBox: await mk("Caja de Ana", "sorted_box", "ana", "for_sale"),

    // Martín has asked for one back and already has the other at home.
    martinRetired: await mk("Carpeta de Martín", "binder", "martin", "retired"),
    martinHome: await mk("Carpeta vieja de Martín", "binder", "martin", "released"),

    // Sofía is on her way to the shop with hers.
    sofiaReturning: await mk("Caja de Sofía", "unsorted_box", "sofia", "returning"),
  };
  log(`${Object.keys(units).length} containers: 3 shop, 5 consigned, all four states`);
  return units;
}

// File every copy of every card into a container. A copy belongs in a container
// owned by the same person as the card, or in one of the shop's.
async function fileStock(people, units) {
  const cards = await prisma.card.findMany({
    include: { collection: { select: { playerid: true } } },
  });

  // Which containers each consignor's cards may go into.
  const byOwner = new Map([
    [people.ana.player.id, [units.anaBinder, units.anaBox]],
    [people.martin.player.id, [units.martinRetired, units.martinHome]],
    [people.sofia.player.id, [units.sofiaReturning]],
    [people.diego.player.id, [units.vitrina, units.commons]],
    [people.fede.player.id, [units.vitrina, units.ordenada, units.commons]],
  ]);

  // Next free coordinate per container.
  const cursor = new Map();
  const nextSpot = (unit) => {
    const state = cursor.get(unit.id) ?? { page: 1, pocket: 1, sequence: 1 };
    const spot = { ...state };
    if (unit.type === "binder") {
      state.pocket++;
      if (state.pocket > 9) {
        state.pocket = 1;
        state.page++;
      }
    } else {
      state.sequence++;
    }
    cursor.set(unit.id, state);
    return spot;
  };

  // Round-robin rather than a random pick: with only a few dozen cards, random
  // choice reliably left one container empty, and an empty sorted box is one
  // fewer thing to click on.
  const turn = new Map();
  const nextUnit = (options, ownerKey) => {
    const i = turn.get(ownerKey) ?? 0;
    turn.set(ownerKey, i + 1);
    return options[i % options.length];
  };

  let filed = 0;
  for (const card of cards) {
    const ownerKey = card.collection.playerid;
    const options = byOwner.get(ownerKey) ?? [units.commons];
    for (let copy = 1; copy <= card.quantity; copy++) {
      const unit = nextUnit(options, ownerKey);
      const spot = nextSpot(unit);
      const data = { cardid: card.id, copyindex: copy, storageid: unit.id };
      if (unit.type === "binder") {
        data.page = spot.page;
        data.pocket = spot.pocket;
        data.depth = 1;
      } else if (unit.type === "sorted_box") {
        data.sequence = spot.sequence;
      }
      await prisma.cardplacement.create({ data });
      filed++;
    }
  }
  log(`${filed} copies filed into containers`);
}

// Orders in every status. The pending one bags its copies, which is what makes
// "reserved" and the pick-up list non-empty.
async function makeOrders(people) {
  // Only sellable stock can be ordered — a card in a retired or released
  // container is not on offer, and seeding an order against one would create a
  // state the API itself refuses to produce.
  const sellable = await prisma.card.findMany({
    where: {
      collection: { active: true },
      cardplacement: { some: { storage: { state: "for_sale" }, orderlineid: null } },
    },
    include: {
      cardgeneral: { select: { name: true } },
      collection: { select: { playerid: true } },
      cardplacement: { where: { storage: { state: "for_sale" }, orderlineid: null } },
    },
  });

  // Sofía reserves two cards she does not own.
  const forSofia = sellable
    .filter((c) => c.collection.playerid !== people.sofia.player.id && c.price)
    .slice(0, 2);

  const pending = await prisma.order.create({
    data: {
      playerid: people.sofia.player.id,
      status: "pending",
      created: now - 2 * 3600,
      note: "Paso el sábado por la tarde.",
      orderline: {
        create: forSofia.map((c) => ({
          cardid: c.id,
          quantity: 1,
          price: c.price ?? "1.00",
        })),
      },
    },
    include: { orderline: true },
  });

  // Bag one copy per line: the placement keeps its address so a cancellation
  // knows where to refile, and gains an orderlineid so it stops showing as
  // being in the pocket.
  for (const line of pending.orderline) {
    const card = forSofia.find((c) => c.id === line.cardid);
    await prisma.cardplacement.update({
      where: { id: card.cardplacement[0].id },
      data: { orderlineid: line.id },
    });
  }

  // Diego picked his up last week.
  const forDiego = sellable
    .filter((c) => c.collection.playerid !== people.diego.player.id && c.price)
    .slice(2, 4);
  await prisma.order.create({
    data: {
      playerid: people.diego.player.id,
      status: "completed",
      created: now - 8 * DAY,
      closed: now - 7 * DAY,
      orderline: {
        create: forDiego.map((c) => ({ cardid: c.id, quantity: 1, price: c.price ?? "1.00" })),
      },
    },
  });

  // And one that fell through, so a cancelled order exists to look at.
  const forAna = sellable
    .filter((c) => c.collection.playerid !== people.ana.player.id && c.price)
    .slice(4, 5);
  await prisma.order.create({
    data: {
      playerid: people.ana.player.id,
      status: "cancelled",
      created: now - 5 * DAY,
      closed: now - 4 * DAY,
      note: "No pudo pasar.",
      orderline: {
        create: forAna.map((c) => ({ cardid: c.id, quantity: 1, price: c.price ?? "1.00" })),
      },
    },
  });

  log(
    `3 orders: pending for Sofía (${pending.orderline.length} bagged), ` +
      `completed for Diego, cancelled for Ana`
  );
}

// Wishlists exercising each kind of constraint, including the border case where
// somebody wishes for a card sitting in their own consigned collection.
async function makeWishlists(people) {
  const entries = [
    // No constraints at all: any printing, language, grade or finish.
    { who: "sofia", name: "Lightning Bolt" },
    // Pinned to a language and a minimum grade.
    { who: "sofia", name: "Counterspell", languageids: [1], conditionids: [1, 2] },
    // Foil only, any printing.
    { who: "diego", name: "Sol Ring", variants: ["foil"] },
    // Several alternatives in one category.
    { who: "diego", name: "Brainstorm", languageids: [1, 2] },
    // A card Ana already has consigned — should surface as a withdrawal, not a
    // purchase: she can just take it back, and nobody pays anybody.
    { who: "ana", name: null, ownStock: true },
    { who: "martin", name: "Tarmogoyf" },
  ];

  let made = 0;
  for (const entry of entries) {
    let name = entry.name;
    if (entry.ownStock) {
      // Find something Ana actually has, so the withdrawal case is real.
      const mine = await prisma.card.findFirst({
        where: { collection: { playerid: people.ana.player.id } },
        include: { cardgeneral: { select: { name: true } } },
      });
      name = mine?.cardgeneral?.name;
    }
    if (!name) continue;
    await prisma.wishlist.create({
      data: {
        playerid: people[entry.who].player.id,
        name,
        created: now - pickInt(1, 20) * DAY,
        versions: entry.versions ?? [],
        languageids: entry.languageids ?? [],
        conditionids: entry.conditionids ?? [],
        variants: entry.variants ?? [],
      },
    });
    made++;
  }
  log(`${made} wishlist entries, including one against the wisher's own stock`);
}

// Sales history and part payment, so the payouts screen has something to
// reconcile. Sale rows are historical facts, independent of current stock.
async function makeHistory(people) {
  const printings = await prisma.cardgeneral.findMany({
    where: { name: { in: WANTED } },
    take: 40,
  });

  const consignors = ["ana", "martin", "sofia", "diego"];
  let sales = 0;
  for (let i = 0; i < 24; i++) {
    const who = people[pick(consignors)];
    const printing = pick(printings);
    await prisma.sale.create({
      data: {
        collectionid: who.collection.id,
        scryfallid: printing.scryfallid,
        price: (pickInt(50, 6000) / 100).toFixed(2),
        percent: who.collection.percent ?? 0.3,
        quantity: pickInt(1, 3),
        date: now - pickInt(1, 90) * DAY,
        conditionid: pick([1, 1, 2, 3]),
        languageid: pick([1, 1, 1, 2]),
        foil: rnd() < 0.2,
      },
    });
    sales++;
  }

  // Ana has been paid once already, so her balance is partial rather than zero
  // or the full total — the interesting case for the payouts screen.
  await prisma.payment.create({
    data: {
      collectionid: people.ana.collection.id,
      date: now - 30 * DAY,
      ammount: "1500.00",
    },
  });
  log(`${sales} historical sales and 1 payment on account`);
}

// ---------------------------------------------------------------------------

async function main() {
  await wipe();
  const people = await makePeople();
  const printings = await resolvePrintings();
  if (!printings.length) {
    throw new Error(
      "No printings found. Run `npm run sync:scryfall` before seeding."
    );
  }
  await makeStock(people, printings);
  await priceStock();
  const units = await makeStorage(people);
  await fileStock(people, units);
  await makeOrders(people);
  await makeWishlists(people);
  await makeHistory(people);

  log("\nCredentials (password is the username followed by 1234):");
  for (const person of PEOPLE) {
    log(
      `  ${person.username.padEnd(8)} ${password(person.username).padEnd(14)} ` +
        `${person.role.padEnd(9)} ${person.name}`
    );
  }
  log(
    "\nWishlist matching runs next (npm run seed:dev chains it). Matches are\n" +
      "left UNRESOLVED on purpose: setting one aside from the admin app is the\n" +
      "flow worth testing, and it is what creates the customer's notification."
  );
}

main()
  .catch((err) => {
    console.error("seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
