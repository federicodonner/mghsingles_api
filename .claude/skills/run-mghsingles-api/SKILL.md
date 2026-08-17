---
name: run-mghsingles-api
description: Build, run, seed and smoke-test the mghsingles Express/Prisma API. Use when asked to start the API, run the backend, set up the mghsingles database, test or curl an endpoint, or check whether an API route works.
---

# Run the mghsingles API

Express 4 + Prisma 6 + PostgreSQL. Single entrypoint `app.js`, listens on
`PORT` (default **3001**). No test suite (`npm test` exits 1 by design).

The agent path is `.claude/skills/run-mghsingles-api/smoke.mjs`: it launches
the server, logs in, probes every route and prints which ones answer, then
adds and deletes a card so the write paths are exercised too. All 17 currently
return 200.

All paths below are relative to `mghsingles_api/`.

## Prerequisites

- Node (verified on v24.4.1, despite `engines: node 16.x` in `package.json`)
- PostgreSQL running locally (verified with Postgres.app, PG 15)

`.env` is committed and points at `postgresql://fefi:root@localhost:5432/mghsingles`.

## Setup

```bash
npm install
```

Create the database if `psql -lqt | grep mghsingles` comes back empty:

```bash
createdb mghsingles
```

Build the schema. **Pin the Prisma CLI to 6.x** — the project has no `prisma`
devDependency, so a bare `npx prisma` fetches v7, which rejects this schema:

```bash
npx prisma@6.14.0 db push
```

`db push` is a dev shortcut — it diffs the schema straight onto the database
and will happily drop a column. There are no migration files in this project,
so anything heading for the Heroku database needs a real migration written by
hand.

Seed lookup tables, card sets and card definitions:

```bash
psql -d mghsingles -v ON_ERROR_STOP=1 -f .claude/skills/run-mghsingles-api/seed.sql
```

Do **not** load `mghsingles.psql`. It predates the current `schema.prisma`
(it has `card.foil` and lacks `card.variant`/`price`/`ckuri`), and every table
in it is empty except the two lookup tables that `seed.sql` reproduces.

Create the dev user (`devuser` / `devpass123`) and promote it to superuser —
`/admin/*` returns 403 without this:

```bash
node .claude/skills/run-mghsingles-api/smoke.mjs --seed-user
```

```bash
psql -d mghsingles -c "UPDATE player SET superuser=true WHERE username='devuser';"
```

Give that user a stocked collection so `/store` is non-empty:

```bash
psql -d mghsingles -v ON_ERROR_STOP=1 -c "
UPDATE collection SET name='Main binder', active=true
 WHERE playerid=(SELECT id FROM player WHERE username='devuser');
INSERT INTO card (scryfallid,conditionid,languageid,quantity,collectionid,variant,approved,price)
SELECT v.sfid,v.cond,1,v.qty,c.id,v.variant,true,v.price
FROM (VALUES ('d573ef03-4730-45aa-93dd-e45ac1dbaf4a',1,1,'nonfoil',4.50),
             ('73542493-cd0b-4bb7-a5b8-8f889c76e4d6',1,8,'nonfoil',0.75),
             ('0df55e3f-14de-46ef-b6b1-616618724d9e',1,2,'nonfoil',3.25),
             ('c4300d24-1cae-4dd5-be7e-38cc677cf5bd',2,1,'nonfoil',1.10),
             -- pf26 #8 is one of the few Llanowar Elves printings that really
             -- is foil-only, so the UI has genuine foil stock to show.
             ('cb49d52e-85ce-4f79-bfc3-0e312e6e161f',1,2,'foil',3.50)) AS v(sfid,cond,qty,variant,price)
CROSS JOIN (SELECT id FROM collection
            WHERE playerid=(SELECT id FROM player WHERE username='devuser') LIMIT 1) c;"
```

Those are real Scryfall ids seeded by `seed.sql`, so the store renders actual
card images. The finishes match what each printing was actually produced in —
`POST /card` rejects anything else.

## Scryfall sync

Pulls every printing into `cardset` + `cardgeneral` so the apps never call
Scryfall on a page load. Verified: **116,712 cards and 1,047 sets in ~8s.**

```bash
npm run sync:scryfall
```

Quick check without the full download:

```bash
node -r dotenv/config scripts/syncScryfall.mjs --limit 3000
```

```bash
node -r dotenv/config scripts/syncScryfall.mjs --dry-run
```

Idempotent — it upserts on `scryfallid` and never deletes, because `card` and
`sale` both reference `cardgeneral` and a printing withdrawn upstream would
otherwise break a sale record.

**It skips itself when there is nothing new.** Scryfall stamps each bulk file
with an id that changes only on regeneration; the script records every run in
`syncrun` and exits early if that id has not moved. Measured: **17s** for a real
sync, **0.8s** to decide there is nothing to do. `--force` re-imports anyway.

**Scheduling.** Scryfall regenerates the bulk files once a day — observed, all
seven within ~17 minutes of **09:05 UTC**. Run this daily at **10:00 UTC**,
which is comfortably after that and 07:00 in Montevideo:

```bash
npm run sync:scryfall
```

Heroku Scheduler, daily at 10:00 UTC, is the intended home. Do not add an
in-process timer — it would fire once per dyno. Running more often than daily is
harmless thanks to the skip, but pointless: the source only changes once a day.

Run it **manually on set-release and spoiler days** rather than waiting for the
schedule — the shop cannot stock or wishlist a card that is not in `cardgeneral`
yet, and that is the one time freshness actually bites.

The script exits non-zero on failure and records the error in `syncrun`, so a
scheduler that has been failing every night is visible rather than silent:

```bash
psql -d mghsingles -c "SELECT started,bulkupdated,cards,skipped,ok,error FROM syncrun ORDER BY id DESC LIMIT 10;"
```

**On a fresh database, run it once before the app is useful** — `cardgeneral`
is empty until it does, so nothing can be stocked, searched or wishlisted.

## CardKingdom price sync (MTGJSON)

Reference prices for every printing, from MTGJSON's daily feed.

```bash
npm run sync:prices
```

Verified: **143,326 price rows in ~6s**, covering 93,492 of 116,712 printings.

The design turns on an asymmetry between the two files it needs:

| file | size | changes |
|---|---|---|
| `AllPricesToday.json.gz` | 5 MB | every day |
| `csv/cardIdentifiers.csv.gz` | 15 MB | never, for an existing printing |

So the MTGJSON uuid is stored once on `cardgeneral.mtgjsonuuid` and the daily
run only fetches the small file. The map is refetched **only when the number of
unmapped printings goes up** — ~6,300 printings (tokens, a long tail of promos)
are simply not in MTGJSON, so "anything unmapped" would otherwise trigger a
15 MB download every night to map nothing. `--force` refetches anyway.

`AllIdentifiers.json.gz` is 217 MB and carries the same mapping; the CSV is the
one to use.

**Where it runs.** The logic is in `services/priceSync.mjs` as a plain function
taking a PrismaClient, with two thin entry points: `scripts/syncPrices.mjs` for
the CLI and `lambda/priceSync.mjs` for AWS. It talks to the database
**directly** rather than posting to the API — ~143k upserts over HTTP would need
batching and auth, would outlive API Gateway's 29s limit, and would make price
night compete with serving customers in the web dyno.

Deploying the Lambda: set `DATABASE_URL`, allow 5 minutes, 512 MB. Prisma ships
a per-platform query engine, so either add `binaryTargets = ["native",
"rhel-openssl-3.0.x"]` to `schema.prisma` or build a container image on Amazon
Linux. Full notes are in the header of `lambda/priceSync.mjs`.

Prices land in `cardprice`, one row per printing per finish per source:
- `retail` — what CardKingdom sells at; the reference for pricing stock
- `buylist` — what it pays; the reference for taking cards in

A row can have a buylist and no retail, meaning CK will buy the card but has
none in stock. Nothing writes `card.price` — the shop's asking price stays the
shop's decision, and the reference is shown beside it in the sell screen.

Freshness for all three jobs:

```bash
curl -s http://localhost:3101/admin/syncstatus -H "Authorization: Bearer $TOK"
```

## Wishlist matching

Finds cards in stock that satisfy somebody's wishlist, so the shop can set them
aside. Scheduled, not hooked to writes: matching is a wishlist-by-stock
comparison, so running it on every add would run it constantly to find nothing,
and would still miss matches created by a reservation lapsing or a customer
editing their filters.

```bash
npm run match:wishlists
```

**Every 10 minutes** via Heroku Scheduler. It is a small query against the
wishlist and the matching stock — not the 77MB Scryfall download — so a short
interval is cheap, and the shop wants to hear about a match while the customer
might still be standing there.

Two kinds of match:
- `purchase` — the card belongs to another consignor; completing writes a sale
- `withdrawal` — the card is in the customer's **own** collection; completing
  removes it from stock and writes **no sale**, because there is no buyer and
  nobody to pay out

Unresolved matches are recomputed each run, so one disappears by itself when the
card sells, the entry is deleted, or the customer narrows their filters past it.
Dismissed matches are marked resolved rather than deleted, so the next run does
not simply re-raise them.

Setting a match aside notifies the customer. That happens at **set-aside**, not
when the match is found: until the shop has physically pulled the card it could
still be sold at the counter, and promising it earlier would be wrong some of
the time.

Notifications are **in-app only** — there is no mail or push infrastructure in
this project. A `notification` row is exactly what a mailer would read, so
adding email later is a job over that table rather than a rewrite. `cardname` is
snapshotted rather than joined, because the card row is deleted once the order
completes and the notice would otherwise blank out just as the customer
collected the thing it was about.

Runs are recorded in `syncrun` alongside the Scryfall sync:

```bash
psql -d mghsingles -c "SELECT source,started,cards,sets,ok,error FROM syncrun ORDER BY id DESC LIMIT 10;"
```

## Run (agent path)

Launch, probe every route, shut down:

```bash
node .claude/skills/run-mghsingles-api/smoke.mjs
```

Against a server you already started:

```bash
API_URL=http://localhost:3001 node .claude/skills/run-mghsingles-api/smoke.mjs --no-launch
```

On a different port (use this when 3001 is taken):

```bash
PORT=3101 node .claude/skills/run-mghsingles-api/smoke.mjs
```

Verified output:

```
api up on http://localhost:3103 (pid 45342)

login: POST /oauth -> 200 token=EF9VRfZmb5MbzJpMKe2XyZDMA superuser=true

200   /store/1                 {"numberOfCards":4,...,"available":6,"reserved":0,...}
200   /store/search/bolt       {"numberOfCards":1,"numberOfPages":1,...}
200   /card/modifiers          {"conditions":[{"id":1,"name":"NM"},...
200   /card/sets               [{"cardsetname":"Core Set 2021",...
200   /card/set/lea            {"cards":[{"scryfallid":"0df55e3f-...","name":"Counterspell",...
200   /player/me               {"username":"devuser",...,"superuser":true}
200   /collection              [{"id":1,"playerid":1,"active":true,...
200   /collection/1            {"id":1,"active":true,"percent":"0.3",...
200   /collection/all          [{"id":1,"name":"Dev User"},{"id":3,...
200   /sale                    {"active":true,...,"sales":[...]}
200   /admin/me                {"username":"devuser",...}
200   /admin/pendingpayments   [{"name":"Dev User","sales":"10020.00",...}]
200   /storage                 [{"id":4,"name":"Binder de Fede","type":"binder",...
200   /order                   []
200   /wishlist                []
200   /admin/order             [{"id":1,"status":"completed",...
200   /admin/wishlist          [{"name":"Black Lotus","wanted":1,"inStock":0},...

201   POST /card/1             {"message":"Su colección ha sido actualizada con éxito."}
200   DELETE /card/19          {"scryfallid":"c4300d24-..."}

0 route(s) never answered; 0 unhandled rejection(s) in server log
```

`HANG` in that output means a handler threw without responding. It should never
appear now that every handler is wrapped — if it does, something regressed.

### Long-running server (what the UIs connect to)

```bash
PORT=3101 node -r dotenv/config app.js
```

Loading dotenv explicitly is required (see Gotchas). `--unhandled-rejections=warn`
used to be mandatory to stop one bad request killing the process; the
`asyncHandler` wrapper and the error middleware in `app.js` make it unnecessary.

### Hand-rolled requests

```bash
curl -s -X POST http://localhost:3101/oauth -H 'Content-Type: application/json' \
  -d '{"username":"devuser","password":"devpass123"}'
```

```bash
TOK=$(curl -s -X POST http://localhost:3101/oauth -H 'Content-Type: application/json' \
  -d '{"username":"devuser","password":"devpass123"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
curl -s http://localhost:3101/player/me -H "Authorization: Bearer $TOK"
```

## Run (human path)

```bash
npm run start-dev
```

Two caveats, both verified:

- `nodemon` is **not** in `package.json` — this only works if you have it
  installed globally (`npm i -g nodemon`).
- nodemon does **not** restart after a crash — it prints `[nodemon] app crashed
  - waiting for file changes before starting...` and stays down until you touch
  a file. Less likely to bite now that handlers can't take the process down,
  but it is still how nodemon behaves.

`npm start` runs `node app.js` with **no dotenv preload**, so `DATABASE_URL` is
unset and every query fails at runtime. Don't use it.

## Gotchas

- **`npx prisma` installs v7 and refuses the schema** with `P1012: The
  datasource property url is no longer supported`. There is no `prisma` entry
  in `devDependencies`, so the version is unpinned. Always use `npx prisma@6.14.0`.

- **`npm start` silently has no database.** Only `start-dev` preloads dotenv —
  and `start-dev` needs a globally installed `nodemon`, which is not a project
  dependency.

- **Every async handler must be wrapped in `asyncHandler`.** In Express 4 a
  rejected promise in a handler is *not* caught: the request hangs forever with
  no response and Node kills the process on the unhandled rejection. Six routes
  used to do exactly this. `middleware/asyncHandler.js` plus the error
  middleware at the bottom of `app.js` turn that into a JSON 500. If you add a
  route, wrap it — nothing else enforces this.

- **`config/db.js` is dead code and must not be used.** It default-exports the
  *factory* `connectDatabase`, so the old `import client from "../config/db.js"`
  + `client.query(...)` pattern threw `client.query is not a function` on every
  call. All routes now use `req.prisma`. Do not reintroduce the raw `pg` client;
  the raw-SQL routes also interpolated user input straight into their queries.

- **Money must use `Prisma.Decimal`, not JS numbers.** `sale.price`,
  `sale.percent` and `payment.ammount` are `Decimal`. Coercing them with
  `Number()` turns a 3002.40 commission into `3002.3999999999996`. See
  `/admin/pendingpayments` for the pattern. Note `collection.percent` is still a
  `Float` in the schema — an inconsistency worth fixing.

- **`/admin/pendingpayments` sums `price` without multiplying by `quantity`**,
  preserving the behaviour of the SQL it replaced. If `price` is per-unit rather
  than a line total, the payout report under-reports. Flagged, not changed.

- **`card` tracks printing as a `variant` string, `sale` as a `foil` boolean.**
  `POST /admin/sale` maps `variant === "foil"` when it writes the sale row.

- **The "pick-up bag" is just the customer's open pending order.** Setting a
  matched card aside appends a line to it rather than inventing a parallel
  concept — "awaiting pickup and payment" is exactly what a pending order
  already means. Reserving is what removes the card from everyone else's
  availability; stock only drops when the order completes.

- **A bagged copy KEEPS its `cardplacement`,** linked to the order line via
  `orderlineid`. The placement is the only record of where the copy belongs,
  and a cancelled order has to be refiled — deleting it would throw that away.
  Everything that shows container contents (`/storage/:id`, `/find`) filters on
  `orderlineid: null`, so the card correctly stops appearing in the pocket it
  has left. Cancelling or expiring clears the link and the card is back;
  completing deletes it, because the card has left the shop.

- **A sale must remove the placement of the copy that actually left.**
  `recordSale`/`recordWithdrawal` take `placementIds` when the sale came from a
  bag. Falling back to "delete every placement whose copyindex exceeds the new
  quantity" is only right when the copy taken was the highest-numbered one —
  selling copy 2 of 4 would otherwise leave copy 2's pocket occupied and wrongly
  empty copy 4's. Counter sales have no such record and still use the fallback.

- **`orderline.kind` decides whether money moves.** A `withdrawal` line is a
  customer collecting a card out of their own consigned collection: priced at
  zero, contributes nothing to the order total, and completing it calls
  `recordWithdrawal` rather than `recordSale`. Writing a sale there would credit
  the owner for buying their own card.

- **Reservations never decrement stock.** An `order` is a claim: availability
  is `card.quantity` minus open `orderline` quantities, computed on read by
  `services/orders.js`. Decrementing would make a held card indistinguishable
  from a sold one and need unwinding on every cancel. Anything that reports
  availability must call `releaseExpiredOrders()` first, or dead holds keep
  stock invisible.

- **Completing an order writes real sale rows.** `POST /admin/order/:id/complete`
  goes through `services/sales.js`, the same path as a counter sale, so the
  consignor is owed their share. An order that skipped it would quietly cheat
  them. Stock is decremented only at that point.

- **`orderline.price` is a snapshot**, captured when the order is placed, so a
  reprice before collection cannot change what the customer was quoted.

- **Wishlist entries are card NAMES, not printings**, stored with Scryfall's
  spelling so they collate regardless of what was typed. `POST /wishlist`
  rejects a name that matches no card — a typo would otherwise sit there
  forever matching nothing. Entries never expire.

- **Wishlist constraints: empty list means "any".** `versions` (scryfallids),
  `languageids`, `conditionids` and `variants` (finish) are independent, and
  several values in one list are alternatives. So `versions: []` +
  `languageids: [1,2]` + `variants: ["foil"]` reads as "any printing, English or
  Spanish, foil only". `PUT /wishlist/:id` replaces a category whole;
  omitting a category leaves it untouched. `matches()` in `routes/wishlist.js`
  is the single implementation — `/admin/wishlist` imports it so the shop's
  demand view answers "does anything on the shelf satisfy what they asked for",
  not merely "same name".

- **`card.variant` is a free-form nullable string, not a lookup table.** A null
  variant means an ordinary card, so wishlist matching treats it as `"normal"` —
  otherwise a card with no finish recorded would satisfy no finish filter at
  all. `/card/modifiers` returns the canonical set (`normal`, `foil`,
  `foil-etched`) unioned with whatever the shop has actually used.

- **`RESERVATION_DAYS` unset means orders never expire** — `expiryFromNow()`
  returns null and `releaseExpiredOrders()` skips null-expiry rows. Set it to a
  positive number to switch timeouts back on; that only affects orders placed
  afterwards, since the deadline is stamped at creation.

- **Storage lives in `storage` + `cardplacement`, not on `collection`.** A
  `storage` row is a binder, sorted box or unsorted box; `playerid` null means
  the shop owns it, and a customer's container can be taken home with
  `inshop: false`. `cardplacement` pins one *copy* of a card row to a spot —
  `copyindex` is 1-based and a row with `quantity: 8` has copies 1..8, which
  can sit in different containers. Binders use page/pocket/depth, sorted boxes
  use sequence, unsorted boxes use none of them. The old `cardposition` table
  and `collection.binder` column are gone.

- **Binder spreads put page 1 alone.** Spread 0 is `[null, 1]`, spread 1 is
  `[2, 3]`, spread 2 is `[4, 5]` — page 1 has nothing facing it, like opening a
  real binder. `spreadForPage()` and `pagesInSpread()` in `routes/storage.js`
  are the only place that arithmetic lives; import them rather than repeating it.

- **`sale.price` is per unit.** Line totals are `price * quantity`. The SQL
  that `/admin/pendingpayments` replaced summed `price` alone and under-reported
  every multi-copy sale.

- **Use the JSONL bulk file, not the JSON one.** `jsonl_download_uri` is
  gzipped one-object-per-line (~77MB), so `scripts/syncScryfall.mjs` streams it
  through `zlib` + `readline` with no parser dependency and no memory growth.
  The plain-JSON variant is a single ~500MB document and needs the whole thing
  resident to parse.

- **Scryfall sends prices as strings** (`"0.35"`). They are cast in SQL
  (`$n::numeric`) rather than converted through a JS number, so Postgres parses
  the decimal exactly.

- **Card search needs the trigram index.** A substring match on `name` across
  ~117k rows is a sequential scan (~56ms and growing); with the GIN trigram
  index it is ~0.7ms. Prisma cannot express that index and there are no
  migration files, so `syncScryfall.mjs` creates it idempotently on every run.

- **Finishes belong to the PRINTING, not to the shop's choice.**
  `cardgeneral.finishes` comes straight from Scryfall: `nonfoil`, `foil`,
  `etched`. Half of all printings exist in only one — 38% nonfoil-only, 12%
  foil-only — so `POST /card` rejects a copy whose finish its printing was never
  produced in. `services/finishes.js` holds the vocabulary; nothing should
  hard-code a finish string.

- **`nonfoil` and `foil` share a printing and therefore share an image**, which
  is why finish is a separate control rather than another version tile. `etched`
  is usually its own printing with its own collector number and art (892 of
  1,218 cases), so it shows up as a tile of its own — but 326 printings do list
  `etched` alongside another finish, so both cases have to work.

- **The old vocabulary was `normal`/`foil`/`foil-etched`,** and non-foil was
  written as `""` by AddCard and `"normal"` by the seed. It is now Scryfall's
  vocabulary throughout, `card.variant` is NOT NULL defaulting to `nonfoil`, and
  a one-off migration mapped the old values across.

- **Scryfall blocks requests without a `User-Agent`.** `fetch` with no headers
  gets an empty body and no error — fields silently come back `undefined`. Send
  `User-Agent` and `Accept: application/json` on every Scryfall call:

  ```bash
  curl -s -H 'User-Agent: mghsingles/1.0' -H 'Accept: application/json' \
    'https://api.scryfall.com/cards/named?exact=Lightning%20Bolt' | head -c 120
  ```

- **`cardgeneral`'s set-code column is `cardsetcode`; `cardset` is the relation**
  to the `cardset` table. Confusingly, the `cardset` table's own primary key is
  also called `cardset`. UI components reading `card.cardset` were crashing on
  `undefined.toUpperCase()`.

- **Only the newest login token per player is valid.** `middleware/authentication.js`
  re-queries the latest `login` row and 403s if the presented token isn't it. So
  running the smoke script logs out any browser session, and vice versa.

- **Usernames are not unique.** `POST /player` only checks that the *email* is
  unused, and `player.username` has no unique constraint, so the same username
  can be registered twice with different emails. Login uses `findFirst({where:{username}})`
  and picks the lowest id. If auth starts behaving oddly, check for duplicates:
  `psql -d mghsingles -c "SELECT id,username,email FROM player ORDER BY id;"`

- **`/admin/*` needs `superuser=true`**, set directly in the database — no API
  route grants it. Without it you get `403 {"message":"Ocurrió un error, ..."}`.

- **`GET /store/:page` now joins `cardgeneral`** and pages in the database.
  It used to load every card and slice in JS, and never joined the card
  definition, so store tiles had no name or image.

- **`middleware/authentication.js` logs debug noise** (`login afuera: [object Object]`,
  `hola`, `chau`) on every authenticated request. Not an error.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `P1012 ... datasource property url is no longer supported` | `npx prisma@6.14.0`, not `npx prisma` |
| `Error: listen EADDRINUSE :::3001` | Something else owns 3001. `lsof -nP -iTCP:3001 -sTCP:LISTEN`, then use `PORT=3101` |
| `PrismaClientInitializationError` / `env(DATABASE_URL)` empty | Started with `npm start`; use `-r dotenv/config` |
| `Cannot GET /store/1` on a port you expected | A *different* Express app is on that port — check with `lsof` |
| Request hangs, server log shows `UnhandledPromiseRejection` | An async handler is missing its `asyncHandler` wrapper |
| Server process vanishes mid-session | An unwrapped async handler threw; wrap it in `asyncHandler` |
| `403 {"message":"Ocurrió un error..."}` on `/admin/*` | User is not superuser; `UPDATE player SET superuser=true ...` |
| `/store/1` returns `numberOfCards: 0` | Collection rows exist but `active` is false, or no `card` rows — re-run the stocking SQL above |
