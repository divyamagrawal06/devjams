import type { ApprovalRefusalReason } from "@farlands/contracts";
import { contentDigest, digestsEqual, TOKEN_PREFIX } from "@farlands/contracts";
import { operationApprovals } from "@repo/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { db, type TransactionType } from "../../db";
import { generateOpaqueToken, hashOpaqueToken, isOpaqueToken } from "../auth/tokens";
import type { CreateServerInput } from "../servers/model";

export const APPROVAL_TTL_MS = 5 * 60 * 1000;
const TOKEN_GENERATION_ATTEMPTS = 3;

export type ApprovalOperation =
  | "create_server"
  | "power_action"
  | "deploy_rules"
  | "rollback_rules";
export type PowerAction = "start" | "stop" | "restart";

export type ApprovalClaim = {
  operation: ApprovalOperation;
  subject: string;
  payload: unknown;
};

export type StoredApproval = {
  tokenHash: string;
  issuedTo: string;
  issuedBy: string;
  operation: string;
  subject: string;
  contentDigest: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
};

export type ApprovalRepository = {
  insert(record: StoredApproval): Promise<boolean>;
  consume(input: {
    tokenHash: string;
    issuedTo: string;
    operation: string;
    subject: string;
    contentDigest: string;
    now: Date;
  }): Promise<boolean>;
  find(tokenHash: string): Promise<StoredApproval | null>;
};

type ApprovalRedemptionInput = {
  token?: string;
  issuedTo: string;
  claim: ApprovalClaim;
};

function redemptionIdentity(input: ApprovalRedemptionInput) {
  if (!input.token || !isOpaqueToken(input.token, TOKEN_PREFIX.approval)) return null;
  return {
    tokenHash: hashOpaqueToken(input.token),
    digest: canonicalApprovalDigest(input.claim),
  };
}

function redemptionRefusal(
  stored: StoredApproval | null,
  input: ApprovalRedemptionInput,
  digest: string,
  now: Date,
): ApprovalRefusalReason {
  if (!stored) return "missing";
  if (stored.issuedTo !== input.issuedTo) return "principal_mismatch";
  if (stored.consumedAt) return "consumed";
  if (stored.expiresAt <= now) return "expired";
  if (
    stored.operation !== input.claim.operation ||
    stored.subject !== input.claim.subject ||
    !digestsEqual(stored.contentDigest, digest)
  ) {
    return "digest_mismatch";
  }
  return "missing";
}

/** Consume a grant on the caller's transaction so its protected write and receipt roll back together. */
export async function redeemOperationApprovalInTransaction(
  tx: TransactionType,
  input: ApprovalRedemptionInput,
  now = new Date(),
): Promise<ApprovalRefusalReason | null> {
  const identity = redemptionIdentity(input);
  if (!identity) return "missing";

  const consumed = await tx
    .update(operationApprovals)
    .set({ consumedAt: now })
    .where(
      and(
        eq(operationApprovals.tokenHash, identity.tokenHash),
        eq(operationApprovals.issuedTo, input.issuedTo),
        eq(operationApprovals.operation, input.claim.operation),
        eq(operationApprovals.subject, input.claim.subject),
        eq(operationApprovals.contentDigest, identity.digest),
        gt(operationApprovals.expiresAt, now),
        isNull(operationApprovals.consumedAt),
      ),
    )
    .returning({ tokenHash: operationApprovals.tokenHash });
  if (consumed.length === 1) return null;

  const [stored] = await tx
    .select()
    .from(operationApprovals)
    .where(eq(operationApprovals.tokenHash, identity.tokenHash))
    .limit(1);
  return redemptionRefusal(stored ?? null, input, identity.digest, now);
}

export function createServerApprovalClaim(userId: string, input: CreateServerInput): ApprovalClaim {
  return {
    operation: "create_server",
    subject: `create:${userId}`,
    payload: input,
  };
}

export function powerActionApprovalClaim(serverId: string, action: PowerAction): ApprovalClaim {
  return {
    operation: "power_action",
    subject: serverId,
    payload: { action },
  };
}

export function deployRulesApprovalClaim(
  serverId: string,
  ruleSetVersion: number,
  contentDigest: string,
): ApprovalClaim {
  return {
    operation: "deploy_rules",
    subject: serverId,
    payload: { ruleSetVersion, contentDigest },
  };
}

export function rollbackRulesApprovalClaim(
  serverId: string,
  ruleSetVersion: number,
  contentDigest: string,
): ApprovalClaim {
  return {
    operation: "rollback_rules",
    subject: serverId,
    payload: { ruleSetVersion, contentDigest },
  };
}

export function canonicalApprovalDigest(claim: ApprovalClaim): string {
  return contentDigest({
    operation: claim.operation,
    subject: claim.subject,
    payload: claim.payload,
  });
}

const drizzleApprovalRepository: ApprovalRepository = {
  async insert(record) {
    const inserted = await db
      .insert(operationApprovals)
      .values(record)
      .onConflictDoNothing()
      .returning({ tokenHash: operationApprovals.tokenHash });
    return inserted.length === 1;
  },

  async consume(input) {
    const consumed = await db
      .update(operationApprovals)
      .set({ consumedAt: sql`now()` })
      .where(
        and(
          eq(operationApprovals.tokenHash, input.tokenHash),
          eq(operationApprovals.issuedTo, input.issuedTo),
          eq(operationApprovals.operation, input.operation),
          eq(operationApprovals.subject, input.subject),
          eq(operationApprovals.contentDigest, input.contentDigest),
          gt(operationApprovals.expiresAt, sql`now()`),
          isNull(operationApprovals.consumedAt),
        ),
      )
      .returning({ tokenHash: operationApprovals.tokenHash });
    return consumed.length === 1;
  },

  async find(tokenHash) {
    const record = await db.query.operationApprovals.findFirst({
      where: eq(operationApprovals.tokenHash, tokenHash),
    });
    return record ?? null;
  },
};

type ApprovalServiceDependencies = {
  now(): Date;
  entropy(size: number): Uint8Array;
};

export class OperationApprovalService {
  constructor(
    private readonly repository: ApprovalRepository = drizzleApprovalRepository,
    private readonly dependencies: ApprovalServiceDependencies = {
      now: () => new Date(),
      entropy: (size) => crypto.getRandomValues(new Uint8Array(size)),
    },
  ) {}

  async mint(input: { issuedTo: string; issuedBy: string; claim: ApprovalClaim }) {
    const now = this.dependencies.now();
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);
    const digest = canonicalApprovalDigest(input.claim);

    for (let attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const token = generateOpaqueToken(TOKEN_PREFIX.approval, this.dependencies.entropy);
      const inserted = await this.repository.insert({
        tokenHash: hashOpaqueToken(token),
        issuedTo: input.issuedTo,
        issuedBy: input.issuedBy,
        operation: input.claim.operation,
        subject: input.claim.subject,
        contentDigest: digest,
        expiresAt,
        consumedAt: null,
        createdAt: now,
      });
      if (inserted) {
        return {
          token,
          expiresAt,
          operation: input.claim.operation,
          subject: input.claim.subject,
        };
      }
    }

    throw new Error("Could not allocate a unique approval token");
  }

  async redeem(input: {
    token?: string;
    issuedTo: string;
    claim: ApprovalClaim;
  }): Promise<ApprovalRefusalReason | null> {
    const identity = redemptionIdentity(input);
    if (!identity) return "missing";
    const now = this.dependencies.now();
    const consumed = await this.repository.consume({
      tokenHash: identity.tokenHash,
      issuedTo: input.issuedTo,
      operation: input.claim.operation,
      subject: input.claim.subject,
      contentDigest: identity.digest,
      now,
    });
    if (consumed) return null;

    const stored = await this.repository.find(identity.tokenHash);
    return redemptionRefusal(stored, input, identity.digest, now);
  }
}

export const operationApprovalService = new OperationApprovalService();
