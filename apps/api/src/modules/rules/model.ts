import { gameTypeEnum } from "@repo/db";
import { Elysia, t } from "elysia";
import { z } from "zod";

export const ruleDto = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  gameType: z.enum(gameTypeEnum.enumValues),
  jsonUrl: z.url(),
  version: z.string().optional(),
});

export type RuleCreateInput = z.infer<typeof ruleDto>;
export type RuleUpdateInput = Partial<RuleCreateInput>;

export const ruleVersionDto = z.object({
  document: z.unknown(),
  source: z.enum(["form", "agent", "director"]),
  provenanceRef: z
    .string()
    .regex(/^[a-zA-Z0-9:/._-]{1,200}$/)
    .optional(),
});

export type RuleVersionCreateInput = z.infer<typeof ruleVersionDto>;

export const RulesModel = new Elysia({ name: "rules.model" }).model({
  "rules.create": ruleDto,
  "rules.update": ruleDto.partial(),
  "rules.version.create": ruleVersionDto,
});
