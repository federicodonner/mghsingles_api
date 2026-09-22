#!/usr/bin/env node
// Launch mghsingles_api and probe every route, reporting which ones work.
//
//   node .claude/skills/run-mghsingles-api/smoke.mjs
//   PORT=3101 node .claude/skills/run-mghsingles-api/smoke.mjs
//   API_URL=http://localhost:3101 node .claude/skills/run-mghsingles-api/smoke.mjs --no-launch
//
// The server is launched with --unhandled-rejections=warn so that a handler
// which somehow escapes its asyncHandler wrapper cannot kill the process
// mid-run and make every later probe report a connection error instead of the
// real problem. A route that throws without responding shows up as HANG.
//
// Accounts come from `npm run seed:dev` (scripts/seedDev.mjs) and the user
// manages their own test data — this script never creates users.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(HERE, "../../..");
// 3101, not 3001: an unrelated project on this machine owns 3001, and pointing
// the smoke run at it silently tests somebody else's server.
const PORT = process.env.PORT || "3101";
const BASE = process.env.API_URL || `http://localhost:${PORT}`;
const LAUNCH = !process.argv.includes("--no-launch");
// The owner account from `npm run seed:dev`. Override with DEV_EMAIL/DEV_PASS.
// Login is by EMAIL — /oauth matches the identifier against player.email.
const EMAIL = process.env.DEV_EMAIL || "fede@example.com";
const PASS = process.env.DEV_PASS || "fede1234";
const TIMEOUT = 8000;

let child = null;
let log = "";

async function up() {
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(`${BASE}/store/1`, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await sleep(200);
    }
  }
  return false;
}

if (LAUNCH) {
  child = spawn("node", ["--unhandled-rejections=warn", "-r", "dotenv/config", "app.js"], {
    cwd: APP_DIR,
    env: { ...process.env, PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  if (!(await up())) {
    console.error("API failed to start on " + BASE + "\n" + log.slice(0, 4000));
    child.kill("SIGKILL");
    process.exit(1);
  }
  console.log(`api up on ${BASE} (pid ${child.pid})\n`);
} else if (!(await up())) {
  console.error(`nothing answering on ${BASE}`);
  process.exit(1);
}

const jfetch = (path, opts = {}) =>
  fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT),
  });

// --- log in ---------------------------------------------------------------
// Sessions coexist: this token is a new login row and does NOT invalidate any
// token a browser session is holding.
let token = null;
{
  const r = await jfetch("/oauth", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const body = await r.json().catch(() => ({}));
  token = body.token || null;
  console.log(
    `login: POST /oauth -> ${r.status}` +
      (token ? ` token=${token} role=${body.role}` : ` ${JSON.stringify(body)}`)
  );
  if (!token)
    console.log(`  (no ${EMAIL}? accounts come from scripts/seedDev.mjs — the user manages test data, do not reseed)`);
}
console.log("");

// --- probe ----------------------------------------------------------------
// The caller's own collection id. Hardcoding 1 broke every time the database
// was reseeded, and reported a route as failing when only the fixture moved.
let myCollectionId = null;
if (token) {
  const r = await jfetch("/collection", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json().catch(() => []);
  myCollectionId = Array.isArray(body) && body.length ? body[0].id : null;
}

const PROBES = [
  ["/store/filters", false],
  ["/store/search?name=a", false],
  ["/card/modifiers", false],
  ["/card/names?q=bolt", false],
  ["/card/sets", false],
  ["/card/set/lea", false],
  ["/player/me", true],
  ["/collection", true],
  [`/collection/${myCollectionId ?? 1}`, true],
  ["/collection/all", true],
  ["/sale", true],
  ["/admin/me", true],
  ["/admin/pendingpayments", true],
  ["/storage", true],
  ["/mystorage", true],
  ["/mystorage/unfiled", true],
  ["/order", true],
  ["/wishlist", true],
  ["/wishlist/covers?cardids=1,2", true],
  ["/admin/order", true],
  ["/admin/wishlist", true],
  ["/admin/condition", true],
  ["/admin/player", true],
  ["/admin/match", true],
  ["/admin/cards/search?q=a", true],
  ["/notification", true],
];

let broken = 0;
for (const [path, auth] of PROBES) {
  if (auth && !token) {
    console.log(`SKIP  ${path.padEnd(24)} no token`);
    continue;
  }
  try {
    const r = await jfetch(path, {
      headers: auth ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = (await r.text()).replace(/\s+/g, " ").slice(0, 90);
    console.log(`${String(r.status).padEnd(5)} ${path.padEnd(24)} ${body}`);
  } catch (e) {
    broken++;
    const hang = /timed out|aborted/i.test(e.message);
    console.log(
      `${(hang ? "HANG" : "ERR").padEnd(5)} ${path.padEnd(24)} ` +
        (hang ? "handler threw, no response (see SKILL.md Gotchas)" : e.message)
    );
  }
}

// --- write routes ------------------------------------------------------
// Add a card then delete it again, so the mutating paths are actually
// exercised and the database is left as it was found.
if (token) {
  console.log("");
  const collections = await jfetch("/collection", {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const collectionId = Array.isArray(collections) ? collections[0]?.id : null;
  const seedCard = collections?.[0]?.card?.[0];
  const scryfallid = seedCard?.scryfallid;
  // Take a finish from the PRINTING rather than from the stored copy: POST
  // /card rejects a finish the printing was never produced in, and a copy
  // recorded before that check existed may itself be wrong.
  const variant = seedCard?.cardgeneral?.finishes?.[0] ?? "nonfoil";

  if (!collectionId || !scryfallid) {
    console.log("SKIP  write routes        no seeded collection/card to work with");
  } else {
    const add = await jfetch(`/card/${collectionId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        scryfallId: scryfallid,
        quantity: 1,
        condition: 3,
        language: 4,
        variant,
      }),
    });
    console.log(
      `${String(add.status).padEnd(5)} POST /card/${collectionId}`.padEnd(30) +
        (await add.text()).replace(/\s+/g, " ").slice(0, 70)
    );

    // Find the row we just made (condition 3 / language 4 is unused by the seed).
    const fresh = await jfetch("/collection", {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const added = fresh?.[0]?.card?.find(
      (c) => c.conditionid === 3 && c.languageid === 4
    );

    if (!added) {
      broken++;
      console.log("FAIL  card was not added; nothing to delete");
    } else {
      const del = await jfetch(`/card/${added.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(
        `${String(del.status).padEnd(5)} DELETE /card/${added.id}`.padEnd(30) +
          (await del.text()).replace(/\s+/g, " ").slice(0, 70)
      );
      if (!del.ok) broken++;
    }
  }
}

if (child) {
  const rejections = (log.match(/UnhandledPromiseRejection|PrismaClientValidationError|TypeError/g) || []).length;
  console.log(`\n${broken} route(s) never answered; ${rejections} unhandled rejection(s) in server log`);
  child.kill("SIGKILL");
} else {
  console.log(`\n${broken} route(s) never answered`);
}
