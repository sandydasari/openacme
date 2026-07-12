import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import matter from "gray-matter";
import { downloadTemplate } from "giget";
import type {
  SkillBundle,
  SkillBundleFile,
  SkillMeta,
  SkillSource,
  TrustLevel,
} from "../types.js";
import { sha256OfBundle } from "../content-hash.js";
import { validateBundlePath } from "../path-validation.js";

const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

interface ParsedIdentifier {
  gitSpec: string;
  skillName?: string;
}

/**
 * Installs a skill out of a pi package (https://pi.dev). A pi package is a
 * repo whose package.json has a `pi` key (`{ skills: ["./dir", …] }`) or a
 * conventional top-level `skills/` directory; each entry is a directory
 * containing a SKILL.md — the same Agent Skills format this hub already
 * speaks. We fetch the repo, locate its skills, and lay down exactly one.
 *
 * Identifier grammar (v1, git only):
 *   github:owner/repo[#ref][:skillName]
 *   any giget-accepted git URL, with an optional ":skillName" suffix
 *
 * `npm:` specs are reserved but rejected — npm tarball fetch is a separate
 * dependency path, deferred. Direct-fetch only: no search, no taps.
 */
export class PiPackageSource implements SkillSource {
  readonly id = "pi-package" as const;

  trustLevelFor(): TrustLevel {
    return "community";
  }

  async search(): Promise<SkillMeta[]> {
    return [];
  }

  async inspect(
    identifier: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<SkillMeta | null> {
    const bundle = await this.fetch(identifier, opts);
    if (!bundle) return null;
    const skillMd = bundle.files.find((f) => f.relPath === "SKILL.md");
    if (!skillMd) return null;
    const fm = matter(new TextDecoder().decode(skillMd.bytes)).data as Record<
      string,
      unknown
    >;
    return {
      name: typeof fm["name"] === "string" ? fm["name"] : bundle.name,
      description:
        typeof fm["description"] === "string" ? fm["description"] : "",
      source: "pi-package",
      identifier,
      trustLevel: "community",
      tags: Array.isArray(fm["tags"])
        ? (fm["tags"] as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [],
      extra: {},
    };
  }

  async fetch(
    identifier: string,
    _opts: { signal?: AbortSignal } = {},
  ): Promise<SkillBundle | null> {
    const parsed = this.parse(identifier);
    if (!parsed) return null;

    const tmpRoot = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "openacme-pi-pkg-"),
    );
    let resolvedRef = "";
    try {
      let result;
      try {
        result = await downloadTemplate(parsed.gitSpec, {
          dir: tmpRoot,
          force: true,
          install: false,
        });
      } catch {
        return null;
      }
      resolvedRef = result.source ?? "";

      const skillDirs = await this.locateSkillDirs(tmpRoot);
      if (skillDirs.length === 0) {
        throw new Error(
          "no pi skills found (expected a `pi.skills` entry in package.json or a `skills/` directory containing SKILL.md folders)",
        );
      }

      const chosen = this.chooseSkillDir(skillDirs, parsed.skillName);
      const files = await this.collectFiles(chosen.dir);
      if (!files.some((f) => f.relPath === "SKILL.md")) return null;

      return {
        name: chosen.name,
        files,
        source: "pi-package",
        sourceIdentifier: identifier,
        resolvedRef,
        contentHash: sha256OfBundle(files),
      };
    } finally {
      await fs.promises.rm(tmpRoot, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------

  parse(identifier: string): ParsedIdentifier | null {
    let rest = identifier.startsWith("pi:") ? identifier.slice(3) : identifier;
    if (/^npm:/i.test(rest)) {
      throw new Error(
        "pi npm packages are not yet supported; use a github: or git URL identifier",
      );
    }
    // A ":skillName" suffix disambiguates a multi-skill package. Distinguish
    // it from the scheme colon in "github:owner/repo" by requiring the suffix
    // to be a bare skill name (no slash) after the final colon.
    let skillName: string | undefined;
    const lastColon = rest.lastIndexOf(":");
    if (lastColon > 0) {
      const tail = rest.slice(lastColon + 1);
      if (/^[a-z0-9][a-z0-9-]*$/i.test(tail) && !tail.includes("/")) {
        // Only treat as a skill suffix when what precedes it still looks like
        // a git spec (has its own scheme colon or a slash).
        const head = rest.slice(0, lastColon);
        if (head.includes("/")) {
          skillName = tail;
          rest = head;
        }
      }
    }
    if (
      !/^(github|gitlab|bitbucket|sourcehut):/i.test(rest) &&
      !/^https?:\/\/.+/i.test(rest) &&
      !/^[\w.-]+\/[\w.-]+/.test(rest)
    ) {
      return null;
    }
    // Bare "owner/repo" defaults to GitHub, which giget also assumes.
    const gitSpec =
      /^[\w.-]+\/[\w.-]+/.test(rest) && !rest.includes(":")
        ? `github:${rest}`
        : rest;
    return { gitSpec, skillName };
  }

  /** Directories (absolute) that contain a SKILL.md, per the pi manifest. */
  private async locateSkillDirs(root: string): Promise<string[]> {
    const manifestDirs = await this.readManifestDirs(root);
    const searchRoots =
      manifestDirs.length > 0
        ? manifestDirs.map((d) => path.resolve(root, d))
        : [path.join(root, "skills")];

    const found = new Set<string>();
    for (const base of searchRoots) {
      if (!fs.existsSync(base)) continue;
      // A search root may itself be a skill dir, or a parent of skill dirs.
      if (fs.existsSync(path.join(base, "SKILL.md"))) {
        found.add(base);
        continue;
      }
      for (const entry of await fs.promises.readdir(base, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const sub = path.join(base, entry.name);
        if (fs.existsSync(path.join(sub, "SKILL.md"))) found.add(sub);
      }
    }
    return [...found].sort();
  }

  private async readManifestDirs(root: string): Promise<string[]> {
    const pkgPath = path.join(root, "package.json");
    if (!fs.existsSync(pkgPath)) return [];
    try {
      const pkg = JSON.parse(await fs.promises.readFile(pkgPath, "utf-8")) as {
        pi?: { skills?: unknown };
      };
      const skills = pkg.pi?.skills;
      if (!Array.isArray(skills)) return [];
      return skills.filter((s): s is string => typeof s === "string");
    } catch {
      return [];
    }
  }

  private chooseSkillDir(
    dirs: string[],
    skillName: string | undefined,
  ): { dir: string; name: string } {
    const named = dirs.map((dir) => ({ dir, name: this.skillNameOf(dir) }));
    if (skillName) {
      const hit = named.find((d) => d.name === skillName);
      if (!hit) {
        throw new Error(
          `skill "${skillName}" not found in package; available: ${named
            .map((d) => d.name)
            .join(", ")}`,
        );
      }
      return hit;
    }
    if (named.length > 1) {
      throw new Error(
        `package has ${named.length} skills; append ":<name>" to pick one — available: ${named
          .map((d) => d.name)
          .join(", ")}`,
      );
    }
    return named[0]!;
  }

  private skillNameOf(dir: string): string {
    try {
      const fm = matter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8"))
        .data as Record<string, unknown>;
      if (typeof fm["name"] === "string" && fm["name"]) return fm["name"];
    } catch {
      /* fall through to dir name */
    }
    return path.basename(dir);
  }

  private async collectFiles(root: string): Promise<SkillBundleFile[]> {
    const out: SkillBundleFile[] = [];
    let total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (out.length >= MAX_FILES) return;
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          validateBundlePath(rel);
        } catch {
          continue;
        }
        const bytes = await fs.promises.readFile(full);
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES) {
          throw new Error(`bundle exceeds ${MAX_TOTAL_BYTES} bytes`);
        }
        out.push({ relPath: rel, bytes: new Uint8Array(bytes) });
      }
    };
    await walk(root, "");
    return out;
  }
}
