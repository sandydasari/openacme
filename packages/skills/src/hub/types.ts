/**
 * Skills Hub types — multi-source skill import.
 *
 * A SkillSource adapts an upstream (GitHub repo, direct URL, Claude
 * marketplace) into the three-method interface the hub orchestrator
 * speaks: search, inspect, fetch.
 */

export type SkillSourceId =
  | "github"
  | "url"
  | "claude-marketplace"
  | "well-known"
  | "local"
  | "git-url"
  | "lobehub"
  | "skills-sh"
  | "clawhub"
  | "builtin"
  | "pi-package";

export type TrustLevel = "trusted" | "community";

export interface SkillMeta {
  name: string;
  description: string;
  source: SkillSourceId;
  /** Source-specific opaque id (e.g. "owner/repo/path" for github). */
  identifier: string;
  trustLevel: TrustLevel;
  repo?: string;
  path?: string;
  tags: string[];
  extra: Record<string, unknown>;
}

export interface SkillBundleFile {
  /** POSIX-style, validated (no "..", absolute, NUL, drive-letter). */
  relPath: string;
  bytes: Uint8Array;
}

export interface SkillBundle {
  name: string;
  files: SkillBundleFile[];
  source: SkillSourceId;
  sourceIdentifier: string;
  /** Git sha, etag, or "" for URL sources. */
  resolvedRef?: string;
  /** sha256 over sorted (relPath, bytes) pairs. Format: "sha256:<hex16>". */
  contentHash: string;
}

export interface SkillSource {
  readonly id: SkillSourceId;
  search(
    query: string,
    opts?: { limit?: number; signal?: AbortSignal },
  ): Promise<SkillMeta[]>;
  inspect(
    identifier: string,
    opts?: { signal?: AbortSignal },
  ): Promise<SkillMeta | null>;
  fetch(
    identifier: string,
    opts?: { signal?: AbortSignal },
  ): Promise<SkillBundle | null>;
  trustLevelFor(identifier: string): TrustLevel;
}

export type TapSource =
  | "github"
  | "claude-marketplace"
  | "well-known"
  | "local";

export interface Tap {
  source: TapSource;
  /**
   * Per-source location:
   *   github / claude-marketplace → "owner/repo"
   *   well-known                  → "https://host" (base URL, no trailing slash)
   *   local                       → absolute filesystem path
   */
  repo: string;
  /**
   * Subpath inside the source:
   *   github                      → "skills/" (or similar)
   *   claude-marketplace          → "" (ignored — marketplace.json lives at repo root)
   *   well-known                  → "" (ignored — /.well-known/skills is fixed)
   *   local                       → optional subdir, defaults to ""
   */
  path: string;
  addedAt: string;
}

export interface HubLockEntry {
  /** Frontmatter `version` if present. */
  version?: string;
  contentHash: string;
  source: SkillSourceId;
  identifier: string;
  resolvedRef?: string;
  trustLevel: TrustLevel;
  installedAt: string;
  updatedAt: string;
  /** RelPaths of every file laid down, for clean uninstall. */
  files: string[];
}

export type AuditAction =
  | "INSTALL"
  | "INSTALL_FAILED"
  | "UPDATE"
  | "UPDATE_FAILED"
  | "UNINSTALL"
  | "UNINSTALL_FAILED"
  | "TAP_ADD"
  | "TAP_REMOVE";

export interface AuditRow {
  ts: string;
  action: AuditAction;
  name?: string;
  source?: SkillSourceId;
  identifier?: string;
  trustLevel?: TrustLevel;
  contentHash?: string;
  oldHash?: string;
  newHash?: string;
  repo?: string;
  outcome: "ok" | "error";
  reason?: string;
}
