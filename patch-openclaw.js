#!/usr/bin/env node
/**
 * patch-openclaw.js
 *
 * Patches the openclaw dist bundles so that the system prompt refers to the
 * plugin exec replacement tool by name instead of the hardcoded string "exec".
 *
 * Two things are patched in every affected bundle:
 *
 *  1. `const execToolName = resolveToolName("exec");`
 *     → falls back to the plugin tool name when no tool named "exec" exists.
 *
 *  2. `"When exec returns approval-pending, ..."` (hardcoded literal)
 *     → uses the `execToolName` variable that was just fixed above.
 *
 * Usage:
 *   node patch-openclaw.js [--tool-name <name>] [--dry-run] [--revert]
 *
 *   --tool-name <name>   Tool name to patch in (default: read from plugin
 *                        config in this directory or fallback to "shell").
 *   --dry-run            Show what would change without writing anything.
 *   --revert             Restore all .bak files and remove the backups.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const revert = args.includes("--revert");
let toolName = null;
const toolNameIdx = args.indexOf("--tool-name");
if (toolNameIdx !== -1 && args[toolNameIdx + 1]) {
  toolName = args[toolNameIdx + 1];
}

// ---------------------------------------------------------------------------
// Read tool name from plugin config if not provided on CLI
// ---------------------------------------------------------------------------
if (!toolName) {
  try {
    // Try reading from the user's openclaw.json (wherever openclaw looks for it)
    const homeOpenclawJson = join(process.env.HOME ?? "/root", ".openclaw", "openclaw.json");
    if (existsSync(homeOpenclawJson)) {
      const cfg = JSON.parse(readFileSync(homeOpenclawJson, "utf8"));
      const pluginCfg = cfg?.plugins?.config?.["bash-env-exec"];
      if (pluginCfg?.toolName) {
        toolName = pluginCfg.toolName;
        console.log(`Read tool name from ~/.openclaw/openclaw.json: "${toolName}"`);
      }
    }
  } catch {
    // ignore
  }
}

if (!toolName) {
  try {
    const manifestPath = join(__dirname, "openclaw.plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // The manifest configSchema doesn't carry a default value; fall through.
    void manifest;
  } catch {
    // ignore
  }
}

if (!toolName) {
  toolName = "shell";
  console.log(`No tool name configured; using default: "${toolName}"`);
}

if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(toolName)) {
  console.error(`Error: tool name "${toolName}" contains characters that are unsafe in JS identifiers.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Locate openclaw dist directory
// ---------------------------------------------------------------------------
let distDir;
try {
  // Resolve from openclaw's own package root
  const openclawPkg = execSync("node -e \"console.log(require.resolve('openclaw/package.json'))\"", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  distDir = join(dirname(openclawPkg), "dist");
} catch {
  // Fallback: check the global npm prefix
  try {
    const prefix = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    distDir = join(prefix, "openclaw", "dist");
  } catch {
    distDir = null;
  }
}

if (!distDir || !existsSync(distDir)) {
  console.error(`Error: could not locate openclaw dist directory (tried: ${distDir}).`);
  console.error("Ensure openclaw is installed globally (npm install -g openclaw) and try again.");
  process.exit(1);
}

console.log(`openclaw dist: ${distDir}`);

// ---------------------------------------------------------------------------
// Find all JS bundles that contain the patterns
// ---------------------------------------------------------------------------
const PATTERN_EXEC_TOOL_NAME = `const execToolName = resolveToolName("exec");`;
const PATTERN_APPROVAL_MSG   = `"When exec returns approval-pending, include the concrete /approve command from tool output (with allow-once|allow-always|deny) and do not ask for a different or rotated code."`;

function findTargetFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".js")) continue;
    const fullPath = join(dir, entry);
    const content = readFileSync(fullPath, "utf8");
    if (content.includes(PATTERN_EXEC_TOOL_NAME)) {
      files.push({ path: fullPath, content });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Revert mode: restore backups
// ---------------------------------------------------------------------------
if (revert) {
  const files = readdirSync(distDir).filter((f) => f.endsWith(".js.bak"));
  if (files.length === 0) {
    console.log("No backup files found to revert.");
    process.exit(0);
  }
  for (const bak of files) {
    const bakPath = join(distDir, bak);
    const origPath = bakPath.replace(/\.bak$/, "");
    if (dryRun) {
      console.log(`[dry-run] would restore: ${origPath}`);
    } else {
      copyFileSync(bakPath, origPath);
      unlinkSync(bakPath);
      console.log(`Reverted: ${origPath}`);
    }
  }
  console.log(dryRun ? "Dry run complete (no files changed)." : "Revert complete.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Patch mode
// ---------------------------------------------------------------------------
const targets = findTargetFiles(distDir);
if (targets.length === 0) {
  console.error("Error: no openclaw dist files found containing the target patterns.");
  console.error("This script may be outdated for your installed openclaw version.");
  process.exit(1);
}

console.log(`\nTool name to patch in: "${toolName}"`);
console.log(`Files to patch: ${targets.length}`);

/**
 * Patch 1: make execToolName resolve the plugin tool name when no built-in
 * "exec" tool is available.
 *
 * Before:
 *   const execToolName = resolveToolName("exec");
 *
 * After:
 *   const execToolName = canonicalByNormalized.get("exec") ?? canonicalByNormalized.get("<toolName>") ?? "<toolName>";
 *
 * `canonicalByNormalized` is in scope at this point (built three lines earlier
 * in the same function). This preserves the original behaviour when the
 * built-in exec IS present, and falls back to the plugin tool name otherwise.
 */
const PATCH1_REPLACEMENT =
  `const execToolName = canonicalByNormalized.get("exec") ?? canonicalByNormalized.get("${toolName}") ?? "${toolName}";`;

/**
 * Patch 2: the hardcoded approval-pending string uses the literal "exec"
 * instead of the `execToolName` variable that patch 1 just fixed. Replace the
 * double-quoted string literal with a template literal.
 */
const PATCH2_REPLACEMENT =
  `\`When \${execToolName} returns approval-pending, include the concrete /approve command from tool output (with allow-once|allow-always|deny) and do not ask for a different or rotated code.\``;

let patchedCount = 0;
let alreadyPatchedCount = 0;

for (const { path: filePath, content } of targets) {
  const bakPath = `${filePath}.bak`;
  const alreadyPatched =
    content.includes(PATCH1_REPLACEMENT) || content.includes(`canonicalByNormalized.get("${toolName}")`);

  if (alreadyPatched) {
    console.log(`\nAlready patched: ${filePath}`);
    alreadyPatchedCount++;
    continue;
  }

  let patched = content;

  // Apply patch 1
  if (patched.includes(PATTERN_EXEC_TOOL_NAME)) {
    patched = patched.replace(PATTERN_EXEC_TOOL_NAME, PATCH1_REPLACEMENT);
    console.log(`\n[patch 1] ${filePath}`);
    console.log(`  - ${PATTERN_EXEC_TOOL_NAME}`);
    console.log(`  + ${PATCH1_REPLACEMENT}`);
  }

  // Apply patch 2
  if (patched.includes(PATTERN_APPROVAL_MSG)) {
    patched = patched.replace(PATTERN_APPROVAL_MSG, PATCH2_REPLACEMENT);
    console.log(`[patch 2] ${filePath}`);
    console.log(`  - ${PATTERN_APPROVAL_MSG}`);
    console.log(`  + ${PATCH2_REPLACEMENT}`);
  }

  if (patched === content) {
    console.log(`\nNo changes needed: ${filePath}`);
    continue;
  }

  if (dryRun) {
    console.log(`  [dry-run] would write ${filePath}`);
  } else {
    // Backup then write
    copyFileSync(filePath, bakPath);
    writeFileSync(filePath, patched, "utf8");
    console.log(`  Written. Backup saved to ${bakPath}`);
  }
  patchedCount++;
}

console.log(`\nSummary:`);
console.log(`  Patched:         ${patchedCount}`);
console.log(`  Already patched: ${alreadyPatchedCount}`);
console.log(`  Skipped:         ${targets.length - patchedCount - alreadyPatchedCount}`);
if (dryRun) {
  console.log("\nDry run — no files were modified. Run without --dry-run to apply.");
} else if (patchedCount > 0) {
  console.log(`\nPatches applied for tool name "${toolName}".`);
  console.log(`To revert: node patch-openclaw.js --revert`);
  console.log(`Note: patches are lost on openclaw upgrade. Re-run this script after upgrading.`);
}
