import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const OPS_DIR = path.join(ROOT_DIR, "apps/ops");
const STAGED_NODE_MODULES_DIR = path.join(OPS_DIR, "node_modules");
const STAGED_NAMESPACE_DIR = path.join(STAGED_NODE_MODULES_DIR, "@croc");
const STAGE_MARKER = path.join(STAGED_NODE_MODULES_DIR, ".workspace-bundle-stage.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyDir(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter(source) {
      const relative = path.relative(sourceDir, source);
      if (!relative) {
        return true;
      }
      const firstSegment = relative.split(path.sep)[0];
      if (["node_modules", ".git", "coverage", "dist"].includes(firstSegment)) {
        return false;
      }
      return true;
    }
  });
}

function collectWorkspacePackageDirs() {
  const packageDirs = [];
  for (const baseDir of ["apps", "packages"]) {
    const absoluteBaseDir = path.join(ROOT_DIR, baseDir);
    if (!fs.existsSync(absoluteBaseDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(absoluteBaseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directPackageJson = path.join(absoluteBaseDir, entry.name, "package.json");
      if (fs.existsSync(directPackageJson)) {
        packageDirs.push(path.join(absoluteBaseDir, entry.name));
        continue;
      }
      for (const nested of fs.readdirSync(path.join(absoluteBaseDir, entry.name), { withFileTypes: true })) {
        if (!nested.isDirectory()) {
          continue;
        }
        const nestedPackageJson = path.join(absoluteBaseDir, entry.name, nested.name, "package.json");
        if (fs.existsSync(nestedPackageJson)) {
          packageDirs.push(path.join(absoluteBaseDir, entry.name, nested.name));
        }
      }
    }
  }
  return packageDirs;
}

function workspacePackageIndex() {
  const index = new Map();
  for (const packageDir of collectWorkspacePackageDirs()) {
    const manifest = readJson(path.join(packageDir, "package.json"));
    if (manifest.name) {
      index.set(manifest.name, {
        dir: packageDir,
        manifest
      });
    }
  }
  return index;
}

function stageBundledWorkspaces() {
  const opsManifest = readJson(path.join(OPS_DIR, "package.json"));
  const bundledDependencies = Array.isArray(opsManifest.bundleDependencies) ? opsManifest.bundleDependencies : [];
  const workspaceIndex = workspacePackageIndex();
  const staged = [];

  ensureDir(STAGED_NAMESPACE_DIR);

  for (const packageName of bundledDependencies) {
    const workspacePackage = workspaceIndex.get(packageName);
    if (!workspacePackage) {
      throw new Error(`workspace_bundle_package_not_found:${packageName}`);
    }
    const scopedName = packageName.split("/")[1];
    const targetDir = path.join(STAGED_NAMESPACE_DIR, scopedName);
    removePath(targetDir);
    copyDir(workspacePackage.dir, targetDir);
    staged.push(targetDir);
  }

  writeJson(STAGE_MARKER, {
    staged_at: new Date().toISOString(),
    staged
  });

  return staged;
}

function cleanupBundledWorkspaces() {
  if (!fs.existsSync(STAGE_MARKER)) {
    return;
  }
  const marker = readJson(STAGE_MARKER);
  for (const stagedPath of marker.staged || []) {
    if (typeof stagedPath === "string" && stagedPath.startsWith(STAGED_NAMESPACE_DIR)) {
      removePath(stagedPath);
    }
  }
  removePath(STAGE_MARKER);

  if (fs.existsSync(STAGED_NAMESPACE_DIR) && fs.readdirSync(STAGED_NAMESPACE_DIR).length === 0) {
    removePath(STAGED_NAMESPACE_DIR);
  }
  if (fs.existsSync(STAGED_NODE_MODULES_DIR) && fs.readdirSync(STAGED_NODE_MODULES_DIR).length === 0) {
    removePath(STAGED_NODE_MODULES_DIR);
  }
}

const action = process.argv[2] || "stage";
if (action === "stage") {
  stageBundledWorkspaces();
} else if (action === "cleanup") {
  cleanupBundledWorkspaces();
} else {
  throw new Error(`unsupported_bundle_workspace_action:${action}`);
}
