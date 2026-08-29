import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./auth-schema";

declare global {
  var indexdWebPool: Pool | undefined;
}

const connectionString = process.env.DATABASE_URL?.trim();

if (!connectionString) {
  throw new Error("DATABASE_URL is required for indexd authentication.");
}

const pool = globalThis.indexdWebPool ?? new Pool({ connectionString, max: 4 });

if (process.env.NODE_ENV !== "production") {
  globalThis.indexdWebPool = pool;
}

export const db = drizzle(pool, { schema });
