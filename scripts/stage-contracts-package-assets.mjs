import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT_DIR, "packages", "contracts");
const TEMPLATES_SOURCE_DIR = path.join(ROOT_DIR, "docs", "templates");
const STAGED_TEMPLATES_DIR = path.join(CONTRACTS_DIR, "templates");
const STAGED_DOCS_DIR = path.join(CONTRACTS_DIR, "protocol-docs");
const STAGE_MARKER = path.join(CONTRACTS_DIR, ".protocol-package-stage.json");

const PROTOCOL_DOC_SOURCES = [
  "docs/current/spec/architecture.md",
  "docs/current/spec/defaults-v0.1.md",
  "docs/current/spec/platform-api-v0.1.md",
  "docs/current/spec/remote-subagent-scope.md",
  "docs/current/guides/integration-playbook.md",
  "docs/current/guides/protocol-pre-split-boundary.md",
  "docs/current/guides/pre-split-naming-matrix.md",
  "docs/current/diagrams/doc-truth-source-map.md"
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, text, "utf8");
}

function copyTree(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true
  });
}

function collectTemplateManifest() {
  const catalogTemplates = fs
    .readdirSync(TEMPLATES_SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();

  const subagentsRoot = path.join(TEMPLATES_SOURCE_DIR, "subagents");
  const subagents = fs
    .readdirSync(subagentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(subagentsRoot, entry.name);
      const files = fs
        .readdirSync(dirPath, { withFileTypes: true })
        .filter((file) => file.isFile())
        .map((file) => file.name)
        .sort();
      return {
        subagent_id: entry.name,
        path: `subagents/${entry.name}`,
        files
      };
    })
    .sort((left, right) => left.subagent_id.localeCompare(right.subagent_id));

  return {
    package_name: readJson(path.join(CONTRACTS_DIR, "package.json")).name,
    staged_at: new Date().toISOString(),
    source_templates_dir: "docs/templates",
    source_protocol_docs: PROTOCOL_DOC_SOURCES,
    catalog_templates: catalogTemplates,
    subagents
  };
}

function stageProtocolDocs() {
  ensureDir(STAGED_DOCS_DIR);

  for (const relativePath of PROTOCOL_DOC_SOURCES) {
    const sourcePath = path.join(ROOT_DIR, relativePath);
    const stagedRelativePath = relativePath.replace(/^docs\//, "");
    const targetPath = path.join(STAGED_DOCS_DIR, stagedRelativePath);
    ensureDir(path.dirname(targetPath));
    fs.copyFileSync(sourcePath, targetPath);
  }

  writeText(
    path.join(STAGED_DOCS_DIR, "README.md"),
    [
      "# Bundled Protocol Docs",
      "",
      "This directory is generated during `@delexec/contracts` packing.",
      "It carries the protocol-side source documents that client/platform consumers may need when consuming the published protocol package.",
      "",
      "The repository remains the authoring source of truth. This bundled copy exists so downstream repositories can consume a release-shaped snapshot."
    ].join("\n") + "\n"
  );
}

function stageContractsPackageAssets() {
  removePath(STAGED_TEMPLATES_DIR);
  removePath(STAGED_DOCS_DIR);

  copyTree(TEMPLATES_SOURCE_DIR, STAGED_TEMPLATES_DIR);
  writeJson(path.join(STAGED_TEMPLATES_DIR, "manifest.json"), collectTemplateManifest());
  stageProtocolDocs();

  writeJson(STAGE_MARKER, {
    staged_at: new Date().toISOString(),
    staged_paths: [STAGED_TEMPLATES_DIR, STAGED_DOCS_DIR]
  });
}

function cleanupContractsPackageAssets() {
  if (!fs.existsSync(STAGE_MARKER)) {
    return;
  }
  const marker = readJson(STAGE_MARKER);
  for (const stagedPath of marker.staged_paths || []) {
    if (typeof stagedPath === "string" && stagedPath.startsWith(CONTRACTS_DIR)) {
      removePath(stagedPath);
    }
  }
  removePath(STAGE_MARKER);
}

const action = process.argv[2] || "stage";
if (action === "stage") {
  stageContractsPackageAssets();
} else if (action === "cleanup") {
  cleanupContractsPackageAssets();
} else {
  throw new Error(`unsupported_protocol_package_action:${action}`);
}
