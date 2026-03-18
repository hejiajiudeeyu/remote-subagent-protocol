import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const SECRET_STORE_VERSION = 1;
const KEY_LENGTH = 32;
const LEGACY_OPS_HOME_ENV = "CROC_OPS_HOME";
const OPS_HOME_ENV = "DELEXEC_HOME";
const LEGACY_OPS_HOME_BASENAME = ".remote-subagent";
const OPS_HOME_BASENAME = ".delexec";
const LEGACY_SQLITE_FILENAME = "croc.sqlite";
const OPS_SQLITE_FILENAME = "delexec.sqlite";

function stripWrappingQuotes(value) {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function toBase64Url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function requirePassphrase(passphrase) {
  const value = String(passphrase || "");
  if (!value.trim()) {
    throw new Error("secret_store_passphrase_required");
  }
  return value;
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(requirePassphrase(passphrase), salt, KEY_LENGTH);
}

function writeSecureTextFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function resolveDefaultOpsHomeDir() {
  return path.join(os.homedir(), OPS_HOME_BASENAME);
}

function resolveLegacyOpsHomeDir() {
  return path.join(os.homedir(), LEGACY_OPS_HOME_BASENAME);
}

function renameOrCopyDir(sourceDir, targetDir) {
  try {
    fs.renameSync(sourceDir, targetDir);
    return;
  } catch (error) {
    if (!error || (error.code !== "EXDEV" && error.code !== "EACCES" && error.code !== "EPERM")) {
      throw error;
    }
  }
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: false });
  fs.rmSync(sourceDir, { recursive: true, force: true });
}

function migrateLegacySqliteFile(homeDir) {
  const legacyFile = path.join(homeDir, LEGACY_SQLITE_FILENAME);
  const nextFile = path.join(homeDir, OPS_SQLITE_FILENAME);
  if (!fs.existsSync(legacyFile) || fs.existsSync(nextFile)) {
    return;
  }
  fs.renameSync(legacyFile, nextFile);
}

export function migrateLegacyOpsHomeDir({
  explicitHomeDir = process.env[OPS_HOME_ENV] || process.env[LEGACY_OPS_HOME_ENV] || null
} = {}) {
  if (explicitHomeDir) {
    const resolved = path.resolve(explicitHomeDir);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      migrateLegacySqliteFile(resolved);
    }
    return resolved;
  }

  const nextHomeDir = path.resolve(resolveDefaultOpsHomeDir());
  const legacyHomeDir = path.resolve(resolveLegacyOpsHomeDir());
  if (!fs.existsSync(legacyHomeDir) || fs.existsSync(nextHomeDir)) {
    if (fs.existsSync(nextHomeDir) && fs.statSync(nextHomeDir).isDirectory()) {
      migrateLegacySqliteFile(nextHomeDir);
    }
    return nextHomeDir;
  }

  fs.mkdirSync(path.dirname(nextHomeDir), { recursive: true, mode: 0o700 });
  renameOrCopyDir(legacyHomeDir, nextHomeDir);
  migrateLegacySqliteFile(nextHomeDir);
  return nextHomeDir;
}

function buildSecretPayload(secrets) {
  return Buffer.from(
    JSON.stringify({
      version: SECRET_STORE_VERSION,
      updated_at: new Date().toISOString(),
      secrets: secrets || {}
    }),
    "utf8"
  );
}

function encryptSecrets(passphrase, secrets, salt = crypto.randomBytes(16)) {
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(buildSecretPayload(secrets)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: SECRET_STORE_VERSION,
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    tag: toBase64Url(tag),
    ciphertext: toBase64Url(ciphertext)
  };
}

function decryptEnvelope(passphrase, envelope) {
  if (!envelope || envelope.version !== SECRET_STORE_VERSION) {
    throw new Error("secret_store_version_unsupported");
  }
  const key = deriveKey(passphrase, fromBase64Url(envelope.salt));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, fromBase64Url(envelope.iv));
  decipher.setAuthTag(fromBase64Url(envelope.tag));
  const plaintext = Buffer.concat([decipher.update(fromBase64Url(envelope.ciphertext)), decipher.final()]).toString("utf8");
  const parsed = JSON.parse(plaintext);
  if (parsed.version !== SECRET_STORE_VERSION || typeof parsed.secrets !== "object" || parsed.secrets === null) {
    throw new Error("secret_store_payload_invalid");
  }
  return parsed;
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

export function updateEnvFile(filePath, updates, options = {}) {
  const removeNull = options.removeNull === true;
  const current = readEnvFile(filePath);
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      if (removeNull) {
        delete next[key];
      }
      continue;
    }
    next[key] = value;
  }
  writeSecureTextFile(filePath, formatEnvFile(next));
  return next;
}

export function getOpsHomeDir() {
  if (process.env[OPS_HOME_ENV]) {
    return path.resolve(process.env[OPS_HOME_ENV]);
  }
  if (process.env[LEGACY_OPS_HOME_ENV]) {
    return path.resolve(process.env[LEGACY_OPS_HOME_ENV]);
  }
  return migrateLegacyOpsHomeDir();
}

export function getOpsEnvFile() {
  return path.join(getOpsHomeDir(), ".env.local");
}

export function getOpsSecretsFile() {
  return path.join(getOpsHomeDir(), "secrets.enc.json");
}

export function getSellerConfigFile() {
  return path.join(getOpsHomeDir(), "seller.config.json");
}

export function getOpsConfigFile() {
  return path.join(getOpsHomeDir(), "ops.config.json");
}

export function ensureOpsDirectories() {
  const homeDir = getOpsHomeDir();
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(homeDir, "logs"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(homeDir, "run"), { recursive: true, mode: 0o700 });
  migrateLegacySqliteFile(homeDir);
  return homeDir;
}

export function buildOpsEnvSearchPaths(rootDir, profileName = null) {
  const homeDir = getOpsHomeDir();
  const paths = [path.join(homeDir, ".env"), path.join(homeDir, ".env.local"), path.join(rootDir, ".env"), path.join(rootDir, ".env.local")];

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
  writeSecureTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function secretStoreExists(filePath) {
  return Boolean(filePath) && fs.existsSync(filePath);
}

export function initializeSecretStore(filePath, passphrase, secrets = {}) {
  if (secretStoreExists(filePath)) {
    throw new Error("secret_store_already_initialized");
  }
  const envelope = encryptSecrets(passphrase, secrets);
  writeSecureTextFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  return {
    initialized: true,
    secret_count: Object.keys(secrets || {}).length
  };
}

export function unlockSecretStore(filePath, passphrase) {
  if (!secretStoreExists(filePath)) {
    throw new Error("secret_store_not_initialized");
  }
  const envelope = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const payload = decryptEnvelope(passphrase, envelope);
  return {
    secrets: payload.secrets,
    updated_at: payload.updated_at || null
  };
}

export function replaceSecretStore(filePath, passphrase, secrets = {}) {
  if (!secretStoreExists(filePath)) {
    throw new Error("secret_store_not_initialized");
  }
  const envelope = encryptSecrets(passphrase, secrets);
  writeSecureTextFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  return {
    updated: true,
    secret_count: Object.keys(secrets || {}).length
  };
}

export function writeSecretValues(filePath, passphrase, updates = {}) {
  const current = unlockSecretStore(filePath, passphrase).secrets;
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      delete next[key];
      continue;
    }
    next[key] = value;
  }
  replaceSecretStore(filePath, passphrase, next);
  return next;
}

export function rotateSecretStorePassphrase(filePath, currentPassphrase, nextPassphrase) {
  const current = unlockSecretStore(filePath, currentPassphrase).secrets;
  const envelope = encryptSecrets(nextPassphrase, current);
  writeSecureTextFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`);
  return {
    rotated: true,
    secret_count: Object.keys(current).length
  };
}
