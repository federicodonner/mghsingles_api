// Prisma CLI configuration.
//
// Prisma 7 moved CLI configuration out of the schema: a `datasource` block can
// no longer carry `url`, and the CLI reads this file instead. It is plain
// JavaScript rather than the TypeScript the docs show — Prisma accepts
// .js/.mjs/.cjs as well, and this project has no TypeScript to justify adding.
//
// The CLI no longer loads .env by itself either, hence the explicit import.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
});
