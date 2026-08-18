// Building a PrismaClient.
//
// Prisma 7 removed the bundled Rust query engine: the client talks to Postgres
// through a driver adapter over the `pg` pool instead. That is the change worth
// having — there is no platform-specific engine binary to ship any more, which
// is what used to make the Lambda in lambda/ fragile (a client generated on
// macOS carried no linux binary, and the failure only appeared on deploy).
//
// It also means a connection URL alone is no longer enough: somebody has to
// construct the pool, so the TLS decision that was implicit is now explicit and
// lives here.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Heroku Postgres presents a self-signed certificate, so verification has to be
// off there or every connection fails. Prisma 6 ignored certificate validation
// entirely; v7 validates by default, which would have broken production
// silently on the first deploy. Locally there is no TLS at all.
//
// Same rule as config/db.js, which the legacy CardKingdom scrape still uses —
// if you change one, change both.
const ssl =
  process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false;

export function createPrismaClient() {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      ssl,
    }),
  });
}

// The API's single long-lived client. Scripts and the Lambda build their own
// with createPrismaClient() and disconnect when they are done, because each is
// a separate process with its own lifetime.
export default createPrismaClient();
