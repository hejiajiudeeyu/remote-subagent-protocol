import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseEnvText(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = stripWrappingQuotes(line.slice(separatorIndex + 1).trim());
    result[key] = value;
  }
  return result;
}

export function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  return parseEnvText(fs.readFileSync(filePath, "utf8"));
}

export function loadEnvFiles(filePaths, { override = false } = {}) {
  for (const filePath of filePaths) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }
    const entries = readEnvFile(filePath);
    for (const [key, value] of Object.entries(entries)) {
      if (override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

export function formatEnvFile(entries) {
  return `${Object.entries(entries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

export function updateEnvFile(filePath, updates) {
  const current = readEnvFile(filePath);
  const next = {
    ...current,
    ...Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined && value !== null)
    )
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, formatEnvFile(next), "utf8");
  return next;
}

export function getOpsHomeDir() {
  return path.resolve(process.env.CROC_OPS_HOME || path.join(os.homedir(), ".remote-subagent"));
}

export function getOpsEnvFile() {
  return path.join(getOpsHomeDir(), ".env.local");
}

export function getSellerConfigFile() {
  return path.join(getOpsHomeDir(), "seller.config.json");
}

export function getOpsConfigFile() {
  return path.join(getOpsHomeDir(), "ops.config.json");
}

export function ensureOpsDirectories() {
  const homeDir = getOpsHomeDir();
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, "run"), { recursive: true });
  return homeDir;
}

export function buildOpsEnvSearchPaths(rootDir, profileName = null) {
  const homeDir = getOpsHomeDir();
  const paths = [
    path.join(homeDir, ".env"),
    path.join(homeDir, ".env.local"),
    path.join(rootDir, ".env"),
    path.join(rootDir, ".env.local")
  ];

  if (profileName) {
    paths.push(path.join(rootDir, `deploy/${profileName}/.env`));
    paths.push(path.join(rootDir, `deploy/${profileName}/.env.local`));
  }

  paths.push(path.join(rootDir, "deploy/ops/.env"));
  paths.push(path.join(rootDir, "deploy/ops/.env.local"));
  return paths;
}

export function readJsonFile(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
