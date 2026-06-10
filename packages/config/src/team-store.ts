import * as fs from "node:fs";
import * as path from "node:path";
import matter from "gray-matter";
import { TeamDefinitionSchema, type TeamDefinition } from "./schema.js";
import { createLogger } from "./logger.js";

const log = createLogger("config.team-store");

/**
 * File-based team store. Each team lives in its own folder under
 * `<teamsDir>/<id>/TEAM.md` with a sibling `workspace/` directory shared
 * by all members. Mirrors the AGENT.md convention: structured fields in
 * YAML frontmatter, prose (the charter) as the markdown body.
 *
 * TEAM.md format:
 *   ---
 *   name: Website Redesign
 *   members: [zoe, max]
 *   ---
 *
 *   We ship the new landing page. Zoe is the manager. ...
 */
export interface TeamStore {
  list(): TeamDefinition[];
  get(id: string): TeamDefinition | null;
  upsert(team: TeamDefinition): void;
  /** Absolute path to `<teamsDir>/<id>/`. Null for invalid id shapes. */
  teamDir(id: string): string | null;
  /** Absolute path to `<teamsDir>/<id>/workspace/`. Null for invalid id shapes. */
  workspaceDir(id: string): string | null;
  /** Non-archived teams that list `agentId` as a member. */
  teamsFor(agentId: string): TeamDefinition[];
}

// Same shape rule as agent folders — single safe path segment.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const TEAM_FILE = "TEAM.md";

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function teamFolder(rootDir: string, id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(
      `Invalid team id ${JSON.stringify(id)}: must match ${SAFE_ID} (letters/digits/._- only, no leading dot).`
    );
  }
  return path.join(rootDir, id);
}

function parseTeamFile(filePath: string): TeamDefinition | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { data, content: body } = matter(content);
    // Folder name is the source of truth for the id, same as agents —
    // renaming the folder renames the team; duplicate ids are
    // structurally impossible.
    const id = path.basename(path.dirname(filePath));
    const { id: _ignoredFrontmatterId, ...rest } = data as Record<
      string,
      unknown
    >;
    void _ignoredFrontmatterId;
    return TeamDefinitionSchema.parse({ ...rest, id, charter: body.trim() });
  } catch (e) {
    log.warn({ err: e, filePath }, "skipping malformed team file");
    return null;
  }
}

// js-yaml throws on `undefined` values; strip them before stringify
// (same defense as agent-store).
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripUndefined(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as unknown as T;
  }
  return value;
}

function serializeTeam(team: TeamDefinition): string {
  // Charter goes in the body; the id is the folder name.
  const { charter, id: _id, ...frontmatter } = stripUndefined(team);
  void _id;
  return matter.stringify(charter ? `${charter}\n` : "\n", frontmatter);
}

export function createTeamStore(teamsDir: string): TeamStore {
  return {
    list(): TeamDefinition[] {
      if (!fs.existsSync(teamsDir)) return [];
      const entries = fs.readdirSync(teamsDir, { withFileTypes: true });
      const out: TeamDefinition[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith(".")) continue;
        const filePath = path.join(teamsDir, entry.name, TEAM_FILE);
        if (!fs.existsSync(filePath)) continue;
        const def = parseTeamFile(filePath);
        if (def) out.push(def);
      }
      out.sort((a, b) => a.id.localeCompare(b.id));
      return out;
    },

    get(id: string): TeamDefinition | null {
      if (!SAFE_ID.test(id)) return null;
      const filePath = path.join(teamsDir, id, TEAM_FILE);
      if (!fs.existsSync(filePath)) return null;
      return parseTeamFile(filePath);
    },

    upsert(team: TeamDefinition): void {
      const validated = TeamDefinitionSchema.parse(team);
      for (const member of validated.members) {
        if (!SAFE_ID.test(member)) {
          throw new Error(
            `Invalid member id ${JSON.stringify(member)} in team '${validated.id}'`
          );
        }
      }
      const folder = teamFolder(teamsDir, validated.id);
      const filePath = path.join(folder, TEAM_FILE);
      const folderExistedBefore = fs.existsSync(folder);
      ensureDir(folder);
      ensureDir(path.join(folder, "workspace"));
      try {
        fs.writeFileSync(filePath, serializeTeam(validated), "utf-8");
      } catch (e) {
        // Don't leave a half-built folder behind from a failed first write.
        if (!folderExistedBefore) {
          try {
            fs.rmSync(folder, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
        }
        throw e;
      }
    },

    teamDir(id: string): string | null {
      if (!SAFE_ID.test(id)) return null;
      return path.join(teamsDir, id);
    },

    workspaceDir(id: string): string | null {
      if (!SAFE_ID.test(id)) return null;
      return path.join(teamsDir, id, "workspace");
    },

    teamsFor(agentId: string): TeamDefinition[] {
      return this.list().filter(
        (t) => !t.archived && t.members.includes(agentId)
      );
    },
  };
}
