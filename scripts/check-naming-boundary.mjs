import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const ALLOWED_LEGACY_FILES = new Set([
  "scripts/check-naming-boundary.mjs",
  "docs/planned/design/repo-split-plan.md",
  "docs/current/guides/pre-split-naming-matrix.md",
  "docs/current/guides/rename-local-state-migration-map.md",
  "packages/runtime-utils/src/index.js",
  "apps/ops/package.json",
  "apps/platform-api/package.json",
  "tests/unit/runtime-utils.test.js",
  "package-lock.json",
  "CLAUDE.md"
]);
const LEGACY_TOKENS = [
  "@croc/",
  "croc-ops",
  "croc-platform-api",
  "~/.remote-subagent",
  "croc.sqlite",
  "CROC_OPS_HOME"
];
const TEXT_EXTENSIONS = new Set([".md", ".json", ".js", ".mjs", ".yml", ".yaml", ".txt"]);
const IGNORE_DIRS = new Set([".git", "node_modules", "coverage", "dist", "archive", "issues"]);

function walk(dirPath, files = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

const unexpectedLegacy = [];

for (const filePath of walk(ROOT_DIR)) {
  const relativePath = path.relative(ROOT_DIR, filePath);
  const text = fs.readFileSync(filePath, "utf8");
  for (const token of LEGACY_TOKENS) {
    if (!text.includes(token)) {
      continue;
    }
    if (!ALLOWED_LEGACY_FILES.has(relativePath)) {
      unexpectedLegacy.push(`${relativePath}: unexpected legacy token "${token}"`);
    }
  }
}

if (unexpectedLegacy.length > 0) {
  console.error("[check-naming-boundary] legacy naming tokens remain outside the approved migration map:");
  for (const entry of unexpectedLegacy) {
    console.error(`- ${entry}`);
  }
  process.exit(1);
}

console.log(`[check-naming-boundary] ok allowed_legacy_files=${ALLOWED_LEGACY_FILES.size} tracked_tokens=${LEGACY_TOKENS.length}`);
