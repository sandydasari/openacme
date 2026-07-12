import { z } from "zod";

const SkillSourceIdSchema = z.enum([
  "github",
  "url",
  "claude-marketplace",
  "well-known",
  "local",
  "git-url",
  "lobehub",
  "skills-sh",
  "clawhub",
  "builtin",
  "pi-package",
]);
const TrustLevelSchema = z.enum(["trusted", "community"]);

const ContentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{16}$/, "must be sha256:<16-hex>");

const RepoSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must be owner/repo");
const HttpUrlSchema = z
  .string()
  .regex(/^https?:\/\//i, "must be an http(s) URL")
  .max(1024);
const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s), {
    message: "must be an absolute path",
  });

export const HubLockEntrySchema = z.object({
  version: z.string().max(50).optional(),
  contentHash: ContentHashSchema,
  source: SkillSourceIdSchema,
  identifier: z.string().min(1).max(512),
  resolvedRef: z.string().max(512).optional(),
  trustLevel: TrustLevelSchema,
  installedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  files: z.array(z.string().max(512)).max(200),
});

export const HubLockFileSchema = z.object({
  version: z.literal(1),
  installed: z.record(z.string(), HubLockEntrySchema),
});

const TapBase = {
  path: z.string().max(256).default(""),
  addedAt: z.string().datetime(),
};

export const TapSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("github"), repo: RepoSchema, ...TapBase }),
  z.object({
    source: z.literal("claude-marketplace"),
    repo: RepoSchema,
    ...TapBase,
  }),
  z.object({
    source: z.literal("well-known"),
    repo: HttpUrlSchema,
    ...TapBase,
  }),
  z.object({
    source: z.literal("local"),
    repo: AbsolutePathSchema,
    ...TapBase,
  }),
]);

export const TapsFileSchema = z.object({
  version: z.literal(1),
  taps: z.array(TapSchema),
});

export const AuditActionSchema = z.enum([
  "INSTALL",
  "INSTALL_FAILED",
  "UPDATE",
  "UPDATE_FAILED",
  "UNINSTALL",
  "UNINSTALL_FAILED",
  "TAP_ADD",
  "TAP_REMOVE",
]);

export const AuditRowSchema = z.object({
  ts: z.string().datetime(),
  action: AuditActionSchema,
  name: z.string().optional(),
  source: SkillSourceIdSchema.optional(),
  identifier: z.string().optional(),
  trustLevel: TrustLevelSchema.optional(),
  contentHash: z.string().optional(),
  oldHash: z.string().optional(),
  newHash: z.string().optional(),
  repo: z.string().optional(),
  outcome: z.enum(["ok", "error"]),
  reason: z.string().optional(),
});
