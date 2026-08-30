import { contentDigest } from "@farlands/contracts";
import { buildRuleJar, verifyArtifactBytes } from "@farlands/plugin-builder";
import { ruleArtifacts, ruleSetVersions, serverRuleAssignments, serverRules } from "@repo/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { status } from "elysia";
import { db } from "../../db";
import {
  type RuleCreateInput,
  type RuleUpdateInput,
  type RuleVersionCreateInput,
  ruleDto,
  ruleVersionDto,
} from "./model";

export type DeploymentArtifact = {
  ruleVersionId: string;
  ruleVersion: number;
  contentDigest: string;
  artifactUrl: string;
  artifactDigest: string;
  runtimeDigest: string;
  runtimeMinecraftVersion: string;
  sizeBytes: number;
};

export abstract class RulesService {
  static async create(userId: string, data: RuleCreateInput) {
    data = ruleDto.parse(data);
    const [newRule] = await db
      .insert(serverRules)
      .values({
        id: crypto.randomUUID(),
        createdBy: userId,
        ...data,
      })
      .returning();

    return newRule;
  }

  static async getAllByUser(userId: string) {
    return await db.select().from(serverRules).where(eq(serverRules.createdBy, userId));
  }

  static async update(id: string, userId: string, data: RuleUpdateInput) {
    data = ruleDto.partial().parse(data);
    const [updatedRule] = await db
      .update(serverRules)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(serverRules.id, id), eq(serverRules.createdBy, userId)))
      .returning();

    if (!updatedRule) throw status(404, "Rule not found");
    return updatedRule;
  }

  static async delete(id: string, userId: string) {
    const [deletedRule] = await db
      .delete(serverRules)
      .where(and(eq(serverRules.id, id), eq(serverRules.createdBy, userId)))
      .returning();

    if (!deletedRule) throw status(404, "Rule not found");
    return deletedRule;
  }

  static async createVersion(ruleSetId: string, userId: string, input: RuleVersionCreateInput) {
    const data = ruleVersionDto.parse(input);
    const [owned] = await db
      .select({ id: serverRules.id })
      .from(serverRules)
      .where(and(eq(serverRules.id, ruleSetId), eq(serverRules.createdBy, userId)))
      .limit(1);
    if (!owned) throw status(404, "Rule set not found");

    const built = await buildRuleJar(data.document);
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${ruleSetId}))`);
      const [latest] = await tx
        .select({ version: ruleSetVersions.version })
        .from(ruleSetVersions)
        .where(eq(ruleSetVersions.ruleSetId, ruleSetId))
        .orderBy(desc(ruleSetVersions.version))
        .limit(1);
      const version = (latest?.version ?? 0) + 1;
      const ruleVersionId = `rsv_${crypto.randomUUID().replaceAll("-", "")}`;
      const artifactId = `art_${crypto.randomUUID().replaceAll("-", "")}`;
      const provenanceDigest = data.provenanceRef
        ? contentDigest({ source: data.source, ref: data.provenanceRef })
        : null;

      const [created] = await tx
        .insert(ruleSetVersions)
        .values({
          id: ruleVersionId,
          ruleSetId,
          version,
          jsonUrl: built.jsonUrl,
          contentDigest: built.contentDigest,
          source: data.source,
          provenanceRef: data.provenanceRef ?? null,
          provenanceDigest,
          createdBy: userId,
        })
        .returning();
      await tx.insert(ruleArtifacts).values({
        id: artifactId,
        ruleVersionId,
        artifactUrl: built.jarUrl,
        artifactDigest: built.artifactDigest,
        runtimeDigest: built.runtimeDigest,
        runtimeMinecraftVersion: built.runtimeMinecraftVersion,
        sizeBytes: built.artifactSizeBytes,
      });
      return {
        ...created,
        artifact: {
          artifactDigest: built.artifactDigest,
          runtimeDigest: built.runtimeDigest,
          runtimeMinecraftVersion: built.runtimeMinecraftVersion,
          sizeBytes: built.artifactSizeBytes,
        },
      };
    });
  }

  static async resolveDeploymentArtifact(input: {
    serverId: string;
    userId: string;
    ruleSetVersion: string;
  }): Promise<DeploymentArtifact> {
    const numericVersion = /^\d+$/.test(input.ruleSetVersion) ? Number(input.ruleSetVersion) : null;
    const conditions = [
      eq(serverRules.createdBy, input.userId),
      eq(serverRuleAssignments.serverId, input.serverId),
      eq(serverRuleAssignments.isActive, true),
      numericVersion === null
        ? eq(ruleSetVersions.id, input.ruleSetVersion)
        : eq(ruleSetVersions.version, numericVersion),
    ];
    const rows = await db
      .select({
        ruleVersionId: ruleSetVersions.id,
        ruleVersion: ruleSetVersions.version,
        contentDigest: ruleSetVersions.contentDigest,
        artifactUrl: ruleArtifacts.artifactUrl,
        artifactDigest: ruleArtifacts.artifactDigest,
        runtimeDigest: ruleArtifacts.runtimeDigest,
        runtimeMinecraftVersion: ruleArtifacts.runtimeMinecraftVersion,
        sizeBytes: ruleArtifacts.sizeBytes,
      })
      .from(ruleSetVersions)
      .innerJoin(ruleArtifacts, eq(ruleArtifacts.ruleVersionId, ruleSetVersions.id))
      .innerJoin(serverRules, eq(serverRules.id, ruleSetVersions.ruleSetId))
      .innerJoin(serverRuleAssignments, eq(serverRuleAssignments.ruleId, ruleSetVersions.ruleSetId))
      .where(and(...conditions))
      .limit(2);
    if (rows.length === 0) {
      throw new Error("Reviewed rule artifact is unavailable for this server and owner");
    }
    if (rows.length > 1) {
      throw new Error("Rule version is ambiguous across active server assignments");
    }
    return rows[0] as DeploymentArtifact;
  }

  static async verifyDeploymentArtifact(artifact: DeploymentArtifact): Promise<void> {
    const byteLength = await verifyArtifactBytes(artifact.artifactUrl, artifact.artifactDigest);
    if (byteLength !== artifact.sizeBytes) {
      throw new Error(
        `Stored rule artifact size mismatch: expected ${artifact.sizeBytes}, received ${byteLength}`,
      );
    }
  }
}
