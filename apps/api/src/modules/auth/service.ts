import { machineTokens, sessions } from "@repo/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { status } from "elysia";

import { db } from "../../db";
import { isAdminEmail } from "../admin/allowlist";
import { hashOpaqueToken, isOpaqueToken } from "./tokens";

const SESSION_COOKIE_NAMES = [
  "session_token",
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

const MACHINE_TOKEN_PREFIX = "flk_";

export type HeaderBag = {
  cookie?: string;
  authorization?: string;
};

export type AgentIdentity = {
  userId: string;
  principalId: string;
  kind: "human" | "machine";
};

export abstract class AuthService {
  static unsignedToken(raw: string): string {
    try {
      return decodeURIComponent(raw).split(".")[0] || raw;
    } catch {
      return raw;
    }
  }

  static getSessionToken(cookieHeader: string): string | null {
    const cookies = new Map(
      cookieHeader.split(";").map((part) => {
        const [name, ...valueParts] = part.trim().split("=");
        return [name, valueParts.join("=")] as const;
      }),
    );

    for (const cookieName of SESSION_COOKIE_NAMES) {
      const signedToken = cookies.get(cookieName);
      if (!signedToken) continue;
      return AuthService.unsignedToken(signedToken);
    }

    return null;
  }

  static bearerToken(authorization: string | undefined): string | null {
    const token = AuthService.rawBearerToken(authorization);
    if (!token || token.startsWith(MACHINE_TOKEN_PREFIX)) return null;
    return AuthService.unsignedToken(token);
  }

  static rawBearerToken(authorization: string | undefined): string | null {
    if (!authorization) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
    return match?.[1] ?? null;
  }

  static machineBearerToken(authorization: string | undefined): string | null {
    const token = AuthService.rawBearerToken(authorization);
    return token && isOpaqueToken(token, MACHINE_TOKEN_PREFIX) ? token : null;
  }

  static async lookupSession(token: string) {
    const session = await db.query.sessions.findFirst({
      where: eq(sessions.token, token),
    });

    if (!session || session.expiresAt <= new Date()) return null;
    return session;
  }

  static async getValidSession(cookieHeader: string, authorization?: string) {
    const fromCookie = AuthService.getSessionToken(cookieHeader);
    if (fromCookie) {
      const session = await AuthService.lookupSession(fromCookie);
      if (session) return session;
    }

    const fromBearer = AuthService.bearerToken(authorization);
    if (fromBearer) return AuthService.lookupSession(fromBearer);

    return null;
  }

  static async lookupMachineIdentity(token: string): Promise<AgentIdentity | null> {
    if (!isOpaqueToken(token, MACHINE_TOKEN_PREFIX)) return null;
    const credential = await db.query.machineTokens.findFirst({
      where: and(
        eq(machineTokens.tokenHash, hashOpaqueToken(token)),
        gt(machineTokens.expiresAt, sql`now()`),
        isNull(machineTokens.revokedAt),
      ),
      columns: { id: true, userId: true },
    });
    return credential
      ? { userId: credential.userId, principalId: credential.id, kind: "machine" }
      : null;
  }

  static async requireUserId(cookieHeader: string, authorization?: string): Promise<string> {
    const session = await AuthService.getValidSession(cookieHeader, authorization);
    if (!session) throw status(401, "Authentication required");
    return session.userId;
  }

  static async requireAgentIdentityFromHeaders(headers: HeaderBag): Promise<AgentIdentity> {
    const authorization = headers.authorization;
    const rawBearer = AuthService.rawBearerToken(authorization);
    if (rawBearer?.startsWith(MACHINE_TOKEN_PREFIX)) {
      const machineIdentity = await AuthService.lookupMachineIdentity(rawBearer);
      if (!machineIdentity) throw status(401, "Authentication required");
      return machineIdentity;
    }
    const userId = await AuthService.requireUserId(headers.cookie ?? "", authorization);
    return { userId, principalId: userId, kind: "human" };
  }

  static async requireAgentUserIdFromHeaders(headers: HeaderBag): Promise<string> {
    return (await AuthService.requireAgentIdentityFromHeaders(headers)).userId;
  }

  static async requireUserIdFromHeaders(headers: HeaderBag): Promise<string> {
    return AuthService.requireUserId(headers.cookie ?? "", headers.authorization);
  }

  static async requireHumanSessionUserIdFromHeaders(headers: HeaderBag): Promise<string> {
    const token = AuthService.getSessionToken(headers.cookie ?? "");
    if (!token) throw status(401, "Human session required");
    const session = await AuthService.lookupSession(token);
    if (!session) throw status(401, "Human session required");
    return session.userId;
  }

  static async requireAdminUserId(cookieHeader: string, authorization?: string): Promise<string> {
    const session = await AuthService.getValidSession(cookieHeader, authorization);
    if (!session) throw status(401, "Authentication required");

    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, session.userId),
      columns: {
        email: true,
        emailVerified: true,
      },
    });

    if (!user?.emailVerified || !user.email || !isAdminEmail(user.email)) {
      throw status(403, "Forbidden");
    }

    return session.userId;
  }
}
