#!/usr/bin/env node
/*
 * Generate site changelog entries from Changesets output.
 *
 * All @openacme/* packages share one version (Changesets `fixed` group), so a
 * "release" is one product version. This reads every package CHANGELOG.md,
 * collects the human-written notes per version (dropping the "Updated
 * dependencies" blocks), dedupes them across packages, and writes one
 * content/changelog/<version>.mdx per version that has real notes — verbatim,
 * no rewriting of the text.
 *
 * Existing files are left untouched so hand-polished entries survive — pass
 * --force to overwrite. Run after `pnpm version-packages`:
 *   pnpm --filter docs changelog:gen
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, "..");
const repoRoot = resolve(docsDir, "..", "..");
const outDir = join(docsDir, "content", "changelog");
const force = process.argv.includes("--force");
const REPO = "sandydasari/openacme";

/* Packages in the Changesets `fixed` group share one product version. Packages
   outside it (e.g. tool-host) version independently and must not contribute
   versions to the product changelog. */
function fixedGroup() {
  try {
    const cfg = JSON.parse(readFileSync(join(repoRoot, ".changeset", "config.json"), "utf8"));
    const names = (cfg.fixed ?? []).flat();
    return names.length ? new Set(names) : null;
  } catch {
    return null;
  }
}

function packageName(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
  } catch {
    return null;
  }
}

function changelogFiles() {
  const fixed = fixedGroup();
  const dirs = [join(repoRoot, "apps", "cli")];
  const pkgsDir = join(repoRoot, "packages");
  if (existsSync(pkgsDir)) {
    for (const name of readdirSync(pkgsDir)) dirs.push(join(pkgsDir, name));
  }
  const files = [];
  for (const dir of dirs) {
    const cl = join(dir, "CHANGELOG.md");
    if (!existsSync(cl)) continue;
    if (fixed && !fixed.has(packageName(dir))) continue;
    files.push(cl);
  }
  return files;
}

/* Parse one CHANGELOG.md into { version -> [block, ...] }, where a block is a
   top-level bullet plus its indented continuation. Drops category headers and
   "Updated dependencies" blocks. */
function parseChangelog(text) {
  const byVersion = {};
  let version = null;
  let blocks = null;
  let current = null;
  let skipping = false;

  const flush = () => {
    if (current && blocks) {
      const block = current.join("\n").replace(/\s+$/, "");
      if (block.trim()) blocks.push(block);
    }
    current = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");

    const vm = line.match(/^## +(.+?)\s*$/);
    if (vm) {
      flush();
      version = vm[1].trim();
      blocks = byVersion[version] ?? (byVersion[version] = []);
      skipping = false;
      continue;
    }
    if (version === null) continue;

    if (/^### /.test(line)) {
      flush();
      skipping = false;
      continue;
    }

    if (/^- /.test(line)) {
      flush();
      if (/^- +Updated dependencies/i.test(line)) {
        skipping = true;
        continue;
      }
      skipping = false;
      current = [line];
      continue;
    }

    // continuation / blank line
    if (skipping) continue;
    if (current) current.push(line);
  }
  flush();
  return byVersion;
}

/* Date = when `## <version>` was first committed to a CHANGELOG (the version
   bump). Works for every released version without relying on tags being present
   locally. A brand-new version generated in the Version PR isn't committed yet,
   so this finds nothing → today, which is ~ release day. */
function changelogDate(version, files) {
  const re = `^## ${version.replace(/\./g, "\\.")}$`;
  for (const file of files) {
    try {
      const out = execSync(
        `git -C "${repoRoot}" log --format=%aI -G "${re}" -- "${file}"`,
        { stdio: ["ignore", "pipe", "ignore"] },
      )
        .toString()
        .trim();
      if (out) {
        const lines = out.split("\n");
        return lines[lines.length - 1].slice(0, 10); // oldest = the addition
      }
    } catch {
      // try the next file
    }
  }
  return null;
}

/* Release link is the cli tag's GitHub release — deterministic, so it's correct
   even when generated in the Version PR before the tag exists (it goes live the
   moment publish creates the tag). */
function resolveRelease(version, files) {
  const cliTag = `@openacme/cli@${version}`;
  return {
    date: changelogDate(version, files),
    release: `https://github.com/${REPO}/releases/tag/${encodeURIComponent(cliTag)}`,
  };
}

function main() {
  const files = changelogFiles();
  const merged = {};
  for (const file of files) {
    const parsed = parseChangelog(readFileSync(file, "utf8"));
    for (const [version, blocks] of Object.entries(parsed)) {
      const bucket = merged[version] ?? (merged[version] = { blocks: [], seen: new Set() });
      for (const block of blocks) {
        const key = block.replace(/\s+/g, " ").trim().toLowerCase();
        if (bucket.seen.has(key)) continue;
        bucket.seen.add(key);
        bucket.blocks.push(block);
      }
    }
  }

  mkdirSync(outDir, { recursive: true });
  let written = 0;
  const skippedEmpty = [];
  const skippedExisting = [];

  for (const [version, { blocks }] of Object.entries(merged)) {
    if (blocks.length === 0) {
      skippedEmpty.push(version);
      continue;
    }
    const outFile = join(outDir, `${version}.mdx`);
    if (existsSync(outFile) && !force) {
      skippedExisting.push(version);
      continue;
    }
    const { date, release } = resolveRelease(version, files);
    const frontmatter = [
      "---",
      `title: v${version}`,
      `version: "${version}"`,
      ...(date ? [`date: "${date}"`] : []),
      ...(release ? [`release: "${release}"`] : []),
      "---",
      "",
      blocks.join("\n\n"),
      "",
    ].join("\n");
    writeFileSync(outFile, frontmatter);
    written += 1;
    console.log(`wrote content/changelog/${version}.mdx (${date ?? "no date"})`);
  }

  if (skippedExisting.length)
    console.log(`kept existing: ${skippedExisting.join(", ")} (use --force to overwrite)`);
  if (skippedEmpty.length)
    console.log(`skipped (no release notes): ${skippedEmpty.join(", ")}`);
  console.log(`done — ${written} file(s) written.`);
}

main();
