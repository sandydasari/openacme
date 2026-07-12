import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import matter from "gray-matter";
import { createLogger } from "@openacme/config/logger";
import { SkillRegistry } from "../registry.js";

const log = createLogger("skills.hub");
import { HubLockFile } from "./lockfile.js";
import { TapsManager } from "./taps.js";
import { appendAuditLog, readAuditLog } from "./audit.js";
import { IndexCache } from "./index-cache.js";
import { GitHubAuth } from "./github-auth.js";
import { GitHubSource } from "./sources/github.js";
import { UrlSource } from "./sources/url.js";
import { ClaudeMarketplaceSource } from "./sources/claude-marketplace.js";
import { WellKnownSource } from "./sources/well-known.js";
import { LocalSource } from "./sources/local.js";
import { GitUrlSource } from "./sources/git-url.js";
import { PiPackageSource } from "./sources/pi-package.js";
import { LobeHubSource } from "./sources/lobehub.js";
import { SkillsShSource } from "./sources/skills-sh.js";
import { ClawHubSource } from "./sources/clawhub.js";
import { BuiltinSource } from "./sources/builtin.js";
import { hubDir, skillTargetDir, stagingDir } from "./paths.js";
import {
  InvalidBundlePathError,
  validateBundlePath,
  validateSkillName,
  safeName as sanitizeSkillName,
} from "./path-validation.js";
import type {
  AuditAction,
  AuditRow,
  HubLockEntry,
  SkillBundle,
  SkillMeta,
  SkillSource,
  SkillSourceId,
  TapSource,
  TrustLevel,
} from "./types.js";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

export class HubError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}

export interface InstallResult {
  name: string;
  contentHash: string;
  lockEntry: HubLockEntry;
}

export interface InstallOptions {
  source?: SkillSourceId;
  nameOverride?: string;
  force?: boolean;
  signal?: AbortSignal;
}

export interface SearchOptions {
  source?: "all" | SkillSourceId;
  limit?: number;
  signal?: AbortSignal;
}

export class SkillHub {
  readonly lockfile: HubLockFile;
  readonly taps: TapsManager;
  readonly cache: IndexCache;
  readonly auth: GitHubAuth;
  private readonly github: GitHubSource;
  private readonly url: UrlSource;
  private readonly marketplace: ClaudeMarketplaceSource;
  private readonly wellKnown: WellKnownSource;
  private readonly local: LocalSource;
  private readonly gitUrl: GitUrlSource;
  private readonly piPackage: PiPackageSource;
  private readonly lobehub: LobeHubSource;
  private readonly skillsSh: SkillsShSource;
  private readonly clawhub: ClawHubSource;
  private readonly builtin: BuiltinSource;

  constructor(
    private readonly skillsDir: string,
    private readonly registry: SkillRegistry,
  ) {
    this.lockfile = new HubLockFile(skillsDir);
    this.taps = new TapsManager(skillsDir);
    this.cache = new IndexCache(skillsDir);
    this.auth = new GitHubAuth();
    this.github = new GitHubSource(this.auth, this.cache, () =>
      this.taps.list(),
    );
    this.url = new UrlSource();
    this.marketplace = new ClaudeMarketplaceSource(
      this.github,
      this.auth,
      this.cache,
      () => this.taps.list(),
    );
    this.wellKnown = new WellKnownSource(this.cache, () => this.taps.list());
    this.local = new LocalSource(() => this.taps.list());
    this.gitUrl = new GitUrlSource();
    this.piPackage = new PiPackageSource();
    this.lobehub = new LobeHubSource(this.cache);
    this.skillsSh = new SkillsShSource(this.github, this.cache, this.auth);
    this.clawhub = new ClawHubSource(this.cache);
    this.builtin = new BuiltinSource();
  }

  // ---------------- Public surface ----------------

  async search(query: string, opts: SearchOptions = {}): Promise<SkillMeta[]> {
    const sources = this.pickSources(opts.source);
    const limit = opts.limit ?? 25;
    const seen = new Set<string>();
    const results: SkillMeta[] = [];

    const parts = await Promise.all(
      sources.map((src) => {
        // Per-source 8s ceiling so one wedged catalog can't poison Browse.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8_000);
        const combined = opts.signal
          ? mergeSignals(opts.signal, ctrl.signal)
          : ctrl.signal;
        return src
          .search(query, { limit, signal: combined })
          .catch((err) => {
            log.warn({ err, source: src.id }, "search source failed");
            return [] as SkillMeta[];
          })
          .finally(() => clearTimeout(timer));
      }),
    );

    for (const part of parts) {
      for (const m of part) {
        if (results.length >= limit) return results;
        const key = `${m.source}:${m.identifier}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(m);
      }
    }
    return results;
  }

  async inspect(
    identifier: string,
    opts: { source?: SkillSourceId; signal?: AbortSignal } = {},
  ): Promise<SkillMeta | null> {
    const source = await this.resolveSource(
      identifier,
      opts.source,
      opts.signal,
    );
    if (!source) return null;
    return source.inspect(identifier, { signal: opts.signal });
  }

  async install(
    identifier: string,
    opts: InstallOptions = {},
  ): Promise<InstallResult> {
    const source = await this.resolveSource(
      identifier,
      opts.source,
      opts.signal,
    );
    if (!source) {
      throw new HubError(
        `no source could resolve identifier: ${identifier}`,
        "NO_SOURCE",
      );
    }

    let bundle: SkillBundle | null;
    try {
      bundle = await source.fetch(identifier, { signal: opts.signal });
    } catch (err) {
      this.audit("INSTALL_FAILED", {
        source: source.id,
        identifier,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      throw new HubError(
        `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        "FETCH_FAILED",
      );
    }
    if (!bundle) {
      this.audit("INSTALL_FAILED", {
        source: source.id,
        identifier,
        outcome: "error",
        reason: "source returned no bundle",
      });
      throw new HubError(
        `source returned no bundle for: ${identifier}`,
        "EMPTY_BUNDLE",
      );
    }

    // Validate bundle shape.
    this.validateBundle(bundle);

    const skillMd = bundle.files.find((f) => f.relPath === "SKILL.md")!;
    let fmRaw: unknown;
    try {
      fmRaw = matter(new TextDecoder().decode(skillMd.bytes)).data;
    } catch (err) {
      // Third-party SKILL.md may ship malformed YAML — catch and surface
      // a clean error instead of crashing the install path.
      this.audit("INSTALL_FAILED", {
        source: source.id,
        identifier,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      throw new HubError(
        `SKILL.md frontmatter could not be parsed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        "FRONTMATTER_INVALID",
      );
    }
    const fm = (fmRaw ?? {}) as Record<string, unknown>;
    const fmStr = (k: string): string | undefined =>
      typeof fm[k] === "string" ? (fm[k] as string) : undefined;
    const fmNameRaw = fmStr("name");

    // Name precedence: explicit override → frontmatter → catalog/bundle name.
    // Frontmatter wins over the catalog handle because the SKILL.md is the
    // skill's identity (catalog slugs are often kebab-cased / branded
    // variants that don't match what the author chose).
    const rawName = opts.nameOverride ?? fmNameRaw ?? bundle.name;
    const candidateName = sanitizeSkillName(rawName);
    validateSkillName(candidateName);

    let existing = this.lockfile.get(candidateName);
    const target = skillTargetDir(this.skillsDir, candidateName);
    // Self-heal: lockfile claims installed but the target dir is gone
    // (manual `rm -rf`, partial install, restored backup). Drop the
    // stale entry and proceed with a fresh install.
    if (existing && !fs.existsSync(target)) {
      log.warn(
        { skill: candidateName },
        "healing stale lockfile entry — target dir missing",
      );
      this.lockfile.remove(candidateName);
      existing = undefined;
    }
    if (existing && !opts.force) {
      throw new HubError(
        `skill '${candidateName}' is already installed (use force to overwrite)`,
        "ALREADY_INSTALLED",
      );
    }
    if (!existing && fs.existsSync(target)) {
      // Locally-authored skill (created via `POST /api/skills` or
      // `skills add`) owns this name. Refuse to clobber — even with
      // --force, since the hub shouldn't take over files it didn't put
      // there. Operator must remove the local skill first.
      throw new HubError(
        `skill '${candidateName}' exists locally (not hub-managed) — remove it first with 'skills remove ${candidateName}'`,
        "LOCAL_SKILL_EXISTS",
      );
    }

    const stagingRoot = stagingDir(this.skillsDir);
    fs.mkdirSync(stagingRoot, { recursive: true });
    const staging = path.join(
      stagingRoot,
      `${candidateName}.${process.pid}.${Date.now()}.${crypto.randomUUID().slice(0, 8)}`,
    );
    fs.mkdirSync(staging, { recursive: true });

    try {
      for (const f of bundle.files) {
        // Defense in depth — already validated, but resolve and check
        // before any write.
        validateBundlePath(f.relPath);
        const dest = path.join(staging, f.relPath);
        const destReal = path.resolve(dest);
        if (
          !destReal.startsWith(path.resolve(staging) + path.sep) &&
          destReal !== path.resolve(staging)
        ) {
          throw new InvalidBundlePathError(
            `path escapes staging: ${f.relPath}`,
          );
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.bytes));
      }

      // If forcing over an existing install, remove the live dir first.
      if (fs.existsSync(target)) {
        if (!opts.force) {
          // Shouldn't happen — caught above, but guard anyway.
          throw new HubError(
            `target exists: ${candidateName}`,
            "ALREADY_INSTALLED",
          );
        }
        fs.rmSync(target, { recursive: true, force: true });
      }
      fs.renameSync(staging, target);
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      // Best-effort cleanup of half-written target.
      if (fs.existsSync(target)) {
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch {
          // surface the original error
        }
      }
      this.audit("INSTALL_FAILED", {
        name: candidateName,
        source: source.id,
        identifier,
        outcome: "error",
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const now = new Date().toISOString();
    const entry: HubLockEntry = {
      version: fmStr("version"),
      contentHash: bundle.contentHash,
      source: bundle.source,
      identifier: bundle.sourceIdentifier,
      resolvedRef: bundle.resolvedRef || undefined,
      trustLevel: source.trustLevelFor(identifier),
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      files: bundle.files.map((f) => f.relPath),
    };
    this.lockfile.record(candidateName, entry);
    this.audit("INSTALL", {
      name: candidateName,
      source: bundle.source,
      identifier: bundle.sourceIdentifier,
      trustLevel: entry.trustLevel,
      contentHash: bundle.contentHash,
      outcome: "ok",
    });
    this.registry.loadFromDirectory(this.skillsDir);

    return {
      name: candidateName,
      contentHash: bundle.contentHash,
      lockEntry: entry,
    };
  }

  async update(
    name: string | undefined,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{
    updated: string[];
    unchanged: string[];
    failed: Array<{ name: string; reason: string }>;
  }> {
    const targets = name ? [name] : this.lockfile.list().map((e) => e.name);
    const updated: string[] = [];
    const unchanged: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];

    // Diff-check upstream in parallel — these are read-only HTTPS fetches.
    // The install() step that follows mutates disk + lockfile and stays
    // serialized so two updates can't race on the same target.
    const checks = await Promise.all(
      targets.map(async (n) => {
        const entry = this.lockfile.get(n);
        if (!entry) {
          return { n, kind: "missing" as const };
        }
        try {
          const source = this.sourceById(entry.source);
          const bundle = await source.fetch(entry.identifier, {
            signal: opts.signal,
          });
          if (!bundle) return { n, kind: "empty" as const, entry };
          return { n, kind: "fetched" as const, entry, bundle };
        } catch (err) {
          return {
            n,
            kind: "error" as const,
            entry,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    for (const r of checks) {
      if (r.kind === "missing") {
        failed.push({ name: r.n, reason: "not installed via hub" });
        continue;
      }
      if (r.kind === "empty") {
        failed.push({ name: r.n, reason: "fetch returned empty" });
        continue;
      }
      if (r.kind === "error") {
        this.audit("UPDATE_FAILED", {
          name: r.n,
          source: r.entry.source,
          identifier: r.entry.identifier,
          outcome: "error",
          reason: r.reason,
        });
        failed.push({ name: r.n, reason: r.reason });
        continue;
      }
      if (r.bundle.contentHash === r.entry.contentHash) {
        unchanged.push(r.n);
        continue;
      }
      try {
        await this.install(r.entry.identifier, {
          source: r.entry.source,
          force: true,
          signal: opts.signal,
        });
        this.audit("UPDATE", {
          name: r.n,
          source: r.entry.source,
          identifier: r.entry.identifier,
          oldHash: r.entry.contentHash,
          newHash: r.bundle.contentHash,
          outcome: "ok",
        });
        updated.push(r.n);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.audit("UPDATE_FAILED", {
          name: r.n,
          source: r.entry.source,
          identifier: r.entry.identifier,
          outcome: "error",
          reason,
        });
        failed.push({ name: r.n, reason });
      }
    }
    return { updated, unchanged, failed };
  }

  uninstall(name: string): boolean {
    const entry = this.lockfile.get(name);
    if (!entry) return false;
    const target = skillTargetDir(this.skillsDir, name);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    this.lockfile.remove(name);
    this.audit("UNINSTALL", {
      name,
      source: entry.source,
      identifier: entry.identifier,
      outcome: "ok",
    });
    this.registry.loadFromDirectory(this.skillsDir);
    return true;
  }

  listInstalled(): Array<HubLockEntry & { name: string }> {
    return this.lockfile.list();
  }

  audit(action: AuditAction, row: Omit<AuditRow, "ts" | "action">): void {
    appendAuditLog(this.skillsDir, { action, ...row });
  }

  readAudit(opts: { limit?: number; action?: AuditAction } = {}): AuditRow[] {
    return readAuditLog(this.skillsDir, opts);
  }

  // Taps wrappers (audit on add/remove).
  addTap(input: { source: TapSource; repo: string; path?: string }) {
    const t = this.taps.add(input);
    this.audit("TAP_ADD", { repo: t.repo, outcome: "ok" });
    // Adding a tap can affect search/inspect — invalidate cache so the
    // new repo's tree is fetched fresh.
    this.invalidateIndexCache();
    return t;
  }

  removeTap(repo: string, source?: TapSource): boolean {
    const ok = this.taps.remove(repo, source);
    if (ok) {
      this.audit("TAP_REMOVE", { repo, outcome: "ok" });
      this.invalidateIndexCache();
    }
    return ok;
  }

  listTaps() {
    return this.taps.list();
  }

  // ---------------- Internals ----------------

  private pickSources(filter?: "all" | SkillSourceId): SkillSource[] {
    if (!filter || filter === "all") {
      // Order matters for dedup-by-identifier in search().
      return [
        this.builtin,
        this.github,
        this.marketplace,
        this.wellKnown,
        this.local,
        this.lobehub,
        this.skillsSh,
        this.clawhub,
        this.url,
        this.gitUrl,
      ];
    }
    return [this.sourceById(filter)];
  }

  private sourceById(id: SkillSourceId): SkillSource {
    switch (id) {
      case "github":
        return this.github;
      case "url":
        return this.url;
      case "claude-marketplace":
        return this.marketplace;
      case "well-known":
        return this.wellKnown;
      case "local":
        return this.local;
      case "git-url":
        return this.gitUrl;
      case "lobehub":
        return this.lobehub;
      case "skills-sh":
        return this.skillsSh;
      case "clawhub":
        return this.clawhub;
      case "builtin":
        return this.builtin;
      case "pi-package":
        return this.piPackage;
    }
  }

  private async resolveSource(
    identifier: string,
    explicit?: SkillSourceId,
    signal?: AbortSignal,
  ): Promise<SkillSource | null> {
    if (explicit) return this.sourceById(explicit);
    // Explicit prefixes win before any URL/path heuristic.
    if (identifier.startsWith("well-known:")) return this.wellKnown;
    if (identifier.startsWith("lobehub/")) return this.lobehub;
    // pi packages are opt-in via the `pi:` prefix so a bare owner/repo still
    // routes to GitHub; the prefix disambiguates "install this as a pi pkg".
    if (identifier.startsWith("pi:")) return this.piPackage;
    if (this.gitUrl.looksLikeGitUrl(identifier)) return this.gitUrl;
    // Absolute local-fs path → LocalSource (used by import endpoints).
    if (identifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(identifier)) {
      return this.local;
    }
    if (/^https?:\/\//i.test(identifier)) return this.url;
    // owner/repo[/path] heuristic: try GitHub first; fall back to marketplace.
    if (identifier.includes("/")) {
      const m = await this.github.inspect(identifier, { signal });
      if (m) return this.github;
      const m2 = await this.marketplace.inspect(identifier, { signal });
      if (m2) return this.marketplace;
    }
    // Bare slug: try builtin (the only source that resolves bare names).
    if (!identifier.includes("/")) {
      const m = await this.builtin.inspect(identifier);
      if (m) return this.builtin;
    }
    return null;
  }

  private validateBundle(bundle: SkillBundle): void {
    if (bundle.files.length === 0) {
      throw new HubError("bundle is empty", "EMPTY_BUNDLE");
    }
    if (bundle.files.length > MAX_FILES) {
      throw new HubError(
        `bundle has too many files (${bundle.files.length} > ${MAX_FILES})`,
        "TOO_MANY_FILES",
      );
    }
    let total = 0;
    for (const f of bundle.files) {
      validateBundlePath(f.relPath);
      total += f.bytes.length;
    }
    if (total > MAX_TOTAL_BYTES) {
      throw new HubError(
        `bundle exceeds ${MAX_TOTAL_BYTES} bytes (got ${total})`,
        "TOO_LARGE",
      );
    }
    if (!bundle.files.some((f) => f.relPath === "SKILL.md")) {
      throw new HubError("bundle missing SKILL.md at root", "NO_SKILL_MD");
    }
  }

  private invalidateIndexCache(): void {
    const dir = path.join(hubDir(this.skillsDir), "index-cache");
    if (!fs.existsSync(dir)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // For TrustLevel computation outside the hub.
  trustLevelFor(source: SkillSourceId, identifier: string): TrustLevel {
    return this.sourceById(source).trustLevelFor(identifier);
  }
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onA = () => ctrl.abort(a.reason);
  const onB = () => ctrl.abort(b.reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return ctrl.signal;
}
