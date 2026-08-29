import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";

import { accounts, sessions, userQuotas, users, verifications } from "./auth-schema";
import { db } from "./db";

function requiredEnv(name: "BETTER_AUTH_SECRET" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for indexd authentication.`);
  return value;
}

const baseURL =
  process.env.BETTER_AUTH_URL?.trim() ||
  (process.env.NODE_ENV === "production" ? "https://www.indexd.app" : "http://localhost:3000");

const configuredOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const trustedOrigins = new Set([
  baseURL,
  ...(process.env.NODE_ENV === "production"
    ? ["https://www.indexd.app", "https://indexd.app"]
    : ["http://localhost:3000", "http://127.0.0.1:3000"]),
  ...configuredOrigins,
]);

export const auth = betterAuth({
  baseURL,
  trustedOrigins: [...trustedOrigins],
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),
  databaseHooks: {
    session: {
      create: {
        async after(session) {
          await db.insert(userQuotas).values({ userId: session.userId }).onConflictDoNothing();
        },
      },
    },
  },
  socialProviders: {
    google: {
      clientId: requiredEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
