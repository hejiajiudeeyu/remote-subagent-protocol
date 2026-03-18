import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildStructuredError } from "@delexec/contracts";
import {
  buildTransportEnvUpdates,
  buildTransportSecretUpdates,
  ensureSellerIdentity,
  ensureOpsState,
  hasEncryptedSecretStore,
  listLegacySecretKeys,
  normalizeTransportConfig,
  OPS_SECRET_KEYS,
  readTransportSecretsFromEnv,
  readResolvedOpsSecrets,
  redactTransportConfig,
  removeSubagent,
  saveOpsState,
  scrubLegacySecrets,
  setSubagentEnabled,
  unlockOpsSecrets,
  upsertSubagent,
  writeOpsSecrets
} from "./config.js";
import {
  buildExampleRequestBody,
  buildExampleSubagentDefinition,
  LOCAL_EXAMPLE_DISPLAY_NAME,
  LOCAL_EXAMPLE_SUBAGENT_ID
} from "./example-subagent.js";
import {
  appendServiceLog,
  appendSupervisorEvent,
  getServiceLogFile,
  getSupervisorEventsFile,
  readServiceLogTail,
  readSupervisorEventTail
} from "./logging.js";
import { initializeSecretStore, rotateSecretStorePassphrase } from "@delexec/runtime-utils";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-Ops-Session"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, code, message, { retryable, ...extra } = {}) {
  sendJson(res, statusCode, buildStructuredError(code, message, { retryable, ...extra }));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

async function requestJson(baseUrl, pathname, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

function processBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function parseJsonArrayEnv(value) {
  const normalized = normalizedString(value);
  if (!normalized) {
    return [];
  }
  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [normalized];
  } catch {
    return normalized.split(/\s+/).filter(Boolean);
  }
}

function normalizedString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

const OPS_SESSION_HEADER = "x-ops-session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function createSessionToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function buildTransportSecretLookup(secrets) {
  return {
    [OPS_SECRET_KEYS.transport_emailengine_access_token]: secrets.transport.emailengine.access_token,
    [OPS_SECRET_KEYS.transport_gmail_client_secret]: secrets.transport.gmail.client_secret,
    [OPS_SECRET_KEYS.transport_gmail_refresh_token]: secrets.transport.gmail.refresh_token
  };
}

function buildLegacyTransportSecretEnv(secretUpdates) {
  return {
    TRANSPORT_EMAILENGINE_ACCESS_TOKEN: secretUpdates[OPS_SECRET_KEYS.transport_emailengine_access_token] || undefined,
    TRANSPORT_GMAIL_CLIENT_SECRET: secretUpdates[OPS_SECRET_KEYS.transport_gmail_client_secret] || undefined,
    TRANSPORT_GMAIL_REFRESH_TOKEN: secretUpdates[OPS_SECRET_KEYS.transport_gmail_refresh_token] || undefined
  };
}

function mergeEnvWithResolvedSecrets(env, secrets) {
  return {
    ...env,
    BUYER_PLATFORM_API_KEY: secrets.buyer_api_key || env.BUYER_PLATFORM_API_KEY || env.PLATFORM_API_KEY || "",
    PLATFORM_API_KEY: secrets.buyer_api_key || env.PLATFORM_API_KEY || env.BUYER_PLATFORM_API_KEY || "",
    SELLER_PLATFORM_API_KEY: secrets.seller_platform_api_key || env.SELLER_PLATFORM_API_KEY || "",
    PLATFORM_ADMIN_API_KEY: secrets.platform_admin_api_key || env.PLATFORM_ADMIN_API_KEY || "",
    ...buildTransportSecretLookup(secrets)
  };
}

function pruneExpiredSessions(runtime) {
  const now = Date.now();
  for (const [token, session] of runtime.auth.sessions.entries()) {
    if (session.expiresAt <= now) {
      runtime.auth.sessions.delete(token);
    }
  }
  if (runtime.auth.sessions.size === 0) {
    runtime.auth.unlockedSecrets = null;
    runtime.auth.passphrase = null;
    runtime.auth.unlockedAt = null;
  }
}

function createAuthenticatedSession(runtime, passphrase, secrets) {
  pruneExpiredSessions(runtime);
  const token = createSessionToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  runtime.auth.passphrase = passphrase;
  runtime.auth.unlockedSecrets = secrets;
  runtime.auth.unlockedAt = nowIso();
  runtime.auth.sessions.set(token, {
    token,
    createdAt: nowIso(),
    expiresAt
  });
  return {
    token,
    expires_at: new Date(expiresAt).toISOString()
  };
}

function readSessionToken(req) {
  const headerValue = req.headers[OPS_SESSION_HEADER];
  if (Array.isArray(headerValue)) {
    return headerValue[0] || null;
  }
  return normalizedString(headerValue);
}

function getCurrentSession(runtime, req) {
  pruneExpiredSessions(runtime);
  const token = readSessionToken(req);
  if (!token) {
    return null;
  }
  const session = runtime.auth.sessions.get(token);
  if (!session) {
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return {
    token,
    expires_at: new Date(session.expiresAt).toISOString()
  };
}

function isProtectedRoute(method, pathname) {
  if (pathname === "/healthz" || pathname === "/status" || pathname === "/setup" || pathname.startsWith("/auth/session")) {
    return false;
  }
  if (method === "GET" && pathname === "/") {
    return false;
  }
  return true;
}

function getAuthState(runtime, state) {
  pruneExpiredSessions(runtime);
  const configured = hasEncryptedSecretStore();
  const legacySecretKeys = listLegacySecretKeys(state);
  const activeSession = runtime.auth.sessions.values().next().value || null;
  return {
    configured,
    secret_file: state.secretsFile,
    legacy_secret_keys: legacySecretKeys,
    legacy_secret_source_present: legacySecretKeys.length > 0,
    locked: configured && runtime.auth.sessions.size === 0,
    authenticated: configured ? runtime.auth.sessions.size > 0 : true,
    setup_required: !configured,
    expires_at: activeSession ? new Date(activeSession.expiresAt).toISOString() : null
  };
}

function requireAuthenticatedSession(req, res, runtime, state) {
  if (!hasEncryptedSecretStore()) {
    return { ok: true, session: null };
  }
  const session = getCurrentSession(runtime, req);
  if (!session) {
    sendError(res, 401, "AUTH_SESSION_REQUIRED", "local supervisor session is locked or missing", {
      retryable: false,
      auth: getAuthState(runtime, state)
    });
    return { ok: false, session: null };
  }
  return { ok: true, session };
}

function normalizeTransportPayload(body = {}) {
  return normalizeTransportConfig({ runtime: { transport: body } }, {});
}

function validateTransportConfig(transport) {
  if (!["local", "relay_http", "email"].includes(transport.type)) {
    return { status: 400, body: buildStructuredError("CONTRACT_INVALID_TRANSPORT_TYPE", "unsupported transport type") };
  }
  if (transport.type === "relay_http" && !normalizedString(transport.relay_http?.base_url)) {
    return { status: 400, body: buildStructuredError("CONTRACT_INVALID_TRANSPORT_BODY", "relay_http.base_url is required") };
  }
  if (transport.type === "email") {
    if (!["emailengine", "gmail"].includes(transport.email.provider)) {
      return { status: 400, body: buildStructuredError("CONTRACT_INVALID_TRANSPORT_BODY", "unsupported email provider") };
    }
    if (!normalizedString(transport.email.sender)) {
      return { status: 400, body: buildStructuredError("CONTRACT_INVALID_TRANSPORT_BODY", "email.sender is required") };
    }
    if (!normalizedString(transport.email.receiver)) {
      return { status: 400, body: buildStructuredError("CONTRACT_INVALID_TRANSPORT_BODY", "email.receiver is required") };
    }
    if (transport.email.provider === "emailengine") {
      if (!normalizedString(transport.email.emailengine?.base_url) || !normalizedString(transport.email.emailengine?.account)) {
        return {
          status: 400,
          body: buildStructuredError("CONTRACT_INVALID_TRANSPORT_BODY", "email.emailengine.base_url and account are required")
        };
      }
    }
    if (transport.email.provider === "gmail" && (!normalizedString(transport.email.gmail?.client_id) || !normalizedString(transport.email.gmail?.user))) {
      return {
        status: 400,
        body: buildStructuredError("CONTRACT_INVALID_TRANSPORT_BODY", "email.gmail.client_id and user are required")
      };
    }
  }
  return null;
}

function getRuntimeTransport(state) {
  return normalizeTransportConfig(state.config, state.env);
}

function getResolvedSecrets(state, runtime) {
  return readResolvedOpsSecrets(state, runtime.auth.unlockedSecrets);
}

function getTransportResponse(state, runtime) {
  return redactTransportConfig(state.config.runtime?.transport || {}, mergeEnvWithResolvedSecrets(state.env, getResolvedSecrets(state, runtime)));
}

function buildPlatformHeaders(state, runtime) {
  const secrets = getResolvedSecrets(state, runtime);
  return secrets.buyer_api_key ? { "X-Platform-Api-Key": secrets.buyer_api_key } : {};
}

function findConfiguredExampleSubagent(state) {
  return (state.config.seller?.subagents || []).find((item) => item.subagent_id === LOCAL_EXAMPLE_SUBAGENT_ID) || null;
}

function buildExampleVisibilityError(example) {
  if (!example) {
    return {
      status: 404,
      body: buildStructuredError("EXAMPLE_SUBAGENT_NOT_CONFIGURED", "official example subagent is not configured locally", {
        stage: "add_example_subagent"
      })
    };
  }
  if (example.submitted_for_review !== true) {
    return {
      status: 409,
      body: buildStructuredError("EXAMPLE_REVIEW_NOT_SUBMITTED", "official example subagent must be submitted for review first", {
        stage: "submit_review"
      })
    };
  }
  return {
    status: 409,
    body: buildStructuredError("EXAMPLE_NOT_VISIBLE_IN_CATALOG", "official example subagent is not yet visible in catalog", {
      stage: "approve_and_catalog",
      review_status: example.review_status || "pending"
    })
  };
}

async function testRelayTransport(baseUrl) {
  try {
    const response = await fetch(new URL("/healthz", baseUrl));
    return {
      ok: response.ok,
      kind: "relay_http",
      status: response.status,
      detail: response.ok ? "relay_health_ok" : "relay_health_failed"
    };
  } catch (error) {
    return {
      ok: false,
      kind: "relay_http",
      error: buildStructuredError("TRANSPORT_CONNECTION_FAILED", error instanceof Error ? error.message : "unknown_error")
    };
  }
}

async function testEmailEngineTransport(transport, secrets) {
  if (!secrets.emailengine.access_token) {
    return {
      ok: false,
      kind: "emailengine",
      error: buildStructuredError("AUTH_CREDENTIALS_MISSING", "EmailEngine access token is not configured")
    };
  }

  try {
    const response = await fetch(
      new URL(`/v1/account/${encodeURIComponent(transport.email.emailengine.account)}`, transport.email.emailengine.base_url),
      {
        headers: {
          Authorization: `Bearer ${secrets.emailengine.access_token}`
        }
      }
    );
    if (!response.ok) {
      return {
        ok: false,
        kind: "emailengine",
        status: response.status,
        error: buildStructuredError("AUTH_INVALID_CREDENTIALS", `EmailEngine returned ${response.status}`)
      };
    }
    return {
      ok: true,
      kind: "emailengine",
      status: response.status,
      detail: "emailengine_auth_ok"
    };
  } catch (error) {
    return {
      ok: false,
      kind: "emailengine",
      error: buildStructuredError("TRANSPORT_CONNECTION_FAILED", error instanceof Error ? error.message : "unknown_error")
    };
  }
}

async function getGmailAccessToken(transport, secrets) {
  if (!secrets.gmail.client_secret || !secrets.gmail.refresh_token) {
    return {
      ok: false,
      error: buildStructuredError("AUTH_CREDENTIALS_MISSING", "Gmail client secret or refresh token is not configured")
    };
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: transport.email.gmail.client_id,
        client_secret: secrets.gmail.client_secret,
        refresh_token: secrets.gmail.refresh_token,
        grant_type: "refresh_token"
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.access_token) {
      return {
        ok: false,
        status: response.status,
        error: buildStructuredError("AUTH_INVALID_CREDENTIALS", body?.error_description || body?.error || "gmail_token_refresh_failed")
      };
    }
    return {
      ok: true,
      accessToken: body.access_token
    };
  } catch (error) {
    return {
      ok: false,
      error: buildStructuredError("TRANSPORT_CONNECTION_FAILED", error instanceof Error ? error.message : "unknown_error")
    };
  }
}

async function testGmailTransport(transport, secrets) {
  const token = await getGmailAccessToken(transport, secrets);
  if (!token.ok) {
    return {
      ok: false,
      kind: "gmail",
      ...(token.status ? { status: token.status } : {}),
      error: token.error
    };
  }

  try {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(transport.email.gmail.user)}/profile`, {
      headers: {
        Authorization: `Bearer ${token.accessToken}`
      }
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return {
        ok: false,
        kind: "gmail",
        status: response.status,
        error: buildStructuredError("AUTH_INVALID_CREDENTIALS", body?.error?.message || `gmail_profile_failed_${response.status}`)
      };
    }
    return {
      ok: true,
      kind: "gmail",
      status: response.status,
      detail: "gmail_auth_ok"
    };
  } catch (error) {
    return {
      ok: false,
      kind: "gmail",
      error: buildStructuredError("TRANSPORT_CONNECTION_FAILED", error instanceof Error ? error.message : "unknown_error")
    };
  }
}

async function testTransportConnection(state, runtime) {
  const transport = getRuntimeTransport(state);
  const secrets = getResolvedSecrets(state, runtime).transport;
  if (transport.type === "local") {
    return {
      ok: true,
      kind: "local",
      detail: "local_transport_uses_managed_relay"
    };
  }
  if (transport.type === "relay_http") {
    return testRelayTransport(transport.relay_http.base_url);
  }
  if (transport.email.provider === "emailengine") {
    return testEmailEngineTransport(transport, secrets);
  }
  return testGmailTransport(transport, secrets);
}

function logSeverity(message) {
  if (!message) {
    return null;
  }
  if (/(error|exception|fatal|failed|failure)/i.test(message)) {
    return "error";
  }
  if (/(warn|warning|retry|timeout|denied|reject)/i.test(message)) {
    return "warning";
  }
  return null;
}

export function createOpsSupervisorServer() {
  const state = ensureOpsState();
  appendSupervisorEvent({
    type: "supervisor_created",
    platform_base_url: state.config.platform.base_url
  });
  const runtime = {
    processes: new Map(),
    auth: {
      sessions: new Map(),
      unlockedSecrets: null,
      passphrase: null,
      unlockedAt: null
    }
  };

  function getRuntimeStatus(name) {
    const processInfo = runtime.processes.get(name);
    if (!processInfo) {
      return {
        name,
        running: false,
        launch_mode: null,
        pid: null,
        started_at: null,
        exited_at: null,
        exit_code: null,
        last_error: null
      };
    }
    return {
      name,
      running: !processInfo.exited,
      launch_mode: processInfo.launchMode || null,
      pid: processInfo.child.pid,
      started_at: processInfo.startedAt,
      exited_at: processInfo.exitedAt,
      exit_code: processInfo.exitCode,
      last_error: processInfo.lastError
    };
  }

  function usesManagedRelay() {
    return getRuntimeTransport(state).type === "local";
  }

  function resolveRelayPackageEntry() {
    const candidatePackageJsons = [
      path.resolve(__dirname, "../../transport-relay/package.json"),
      path.resolve(__dirname, "../node_modules/@delexec/transport-relay/package.json")
    ];

    for (const packageJsonPath of candidatePackageJsons) {
      if (!fs.existsSync(packageJsonPath)) {
        continue;
      }
      const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const packageRoot = path.dirname(packageJsonPath);
      if (typeof manifest.bin === "string") {
        return path.resolve(packageRoot, manifest.bin);
      }
      if (manifest.bin && typeof manifest.bin === "object") {
        const relayBin = manifest.bin["delexec-relay"] || Object.values(manifest.bin)[0];
        if (relayBin) {
          return path.resolve(packageRoot, relayBin);
        }
      }
      if (typeof manifest.main === "string") {
        return path.resolve(packageRoot, manifest.main);
      }
    }

    return null;
  }

  function relayLaunchSpec() {
    const configuredBin = normalizedString(process.env.OPS_RELAY_BIN);
    if (configuredBin) {
      return {
        command: configuredBin,
        args: parseJsonArrayEnv(process.env.OPS_RELAY_ARGS),
        mode: "configured_command"
      };
    }

    const packageEntry = resolveRelayPackageEntry();
    if (packageEntry) {
      return {
        command: process.execPath,
        args: [packageEntry],
        mode: "package_entry"
      };
    }

    throw new Error("relay_launch_command_not_found");
  }

  function serviceEnv(name) {
    const ports = state.config.runtime.ports;
    const runtimeTransport = getRuntimeTransport(state);
    const resolvedSecrets = getResolvedSecrets(state, runtime);
    const envWithSecrets = mergeEnvWithResolvedSecrets(state.env, resolvedSecrets);
    const relayBaseUrl =
      runtimeTransport.type === "relay_http"
        ? runtimeTransport.relay_http.base_url
        : processBaseUrl(ports.relay);
    const transportEnv = buildTransportEnvUpdates(
      runtimeTransport.type === "local"
        ? {
            ...runtimeTransport,
            relay_http: { base_url: relayBaseUrl }
          }
        : runtimeTransport,
      envWithSecrets
    );
    const base = {
      ...process.env,
      DELEXEC_HOME: process.env.DELEXEC_HOME || path.dirname(state.envFile),
      PLATFORM_API_BASE_URL: state.config.platform.base_url,
      BUYER_PLATFORM_API_KEY: resolvedSecrets.buyer_api_key || "",
      PLATFORM_API_KEY: resolvedSecrets.buyer_api_key || "",
      BUYER_CONTACT_EMAIL: state.config.buyer.contact_email || "",
      SELLER_ID: state.config.seller.seller_id || "",
      SELLER_SIGNING_PUBLIC_KEY_PEM: state.env.SELLER_SIGNING_PUBLIC_KEY_PEM || "",
      SELLER_SIGNING_PRIVATE_KEY_PEM: state.env.SELLER_SIGNING_PRIVATE_KEY_PEM || "",
      SUBAGENT_IDS: (state.config.seller.subagents || []).map((item) => item.subagent_id).join(","),
      SELLER_PLATFORM_API_KEY: resolvedSecrets.seller_platform_api_key || "",
      TRANSPORT_BASE_URL: relayBaseUrl,
      TRANSPORT_TYPE: runtimeTransport.type,
      TRANSPORT_PROVIDER: transportEnv.TRANSPORT_PROVIDER || "",
      TRANSPORT_EMAIL_PROVIDER: transportEnv.TRANSPORT_EMAIL_PROVIDER || "",
      TRANSPORT_EMAIL_MODE: transportEnv.TRANSPORT_EMAIL_MODE || "",
      TRANSPORT_EMAIL_SENDER: transportEnv.TRANSPORT_EMAIL_SENDER || "",
      TRANSPORT_EMAIL_RECEIVER: transportEnv.TRANSPORT_EMAIL_RECEIVER || "",
      TRANSPORT_EMAIL_POLL_INTERVAL_MS: transportEnv.TRANSPORT_EMAIL_POLL_INTERVAL_MS || "",
      TRANSPORT_EMAILENGINE_BASE_URL: state.env.TRANSPORT_EMAILENGINE_BASE_URL || "",
      TRANSPORT_EMAILENGINE_ACCOUNT: state.env.TRANSPORT_EMAILENGINE_ACCOUNT || "",
      TRANSPORT_EMAILENGINE_ACCESS_TOKEN: resolvedSecrets.transport.emailengine.access_token || "",
      TRANSPORT_GMAIL_CLIENT_ID: state.env.TRANSPORT_GMAIL_CLIENT_ID || "",
      TRANSPORT_GMAIL_USER: state.env.TRANSPORT_GMAIL_USER || "",
      TRANSPORT_GMAIL_CLIENT_SECRET: resolvedSecrets.transport.gmail.client_secret || "",
      TRANSPORT_GMAIL_REFRESH_TOKEN: resolvedSecrets.transport.gmail.refresh_token || ""
    };

    if (name === "relay") {
      return {
        ...base,
        PORT: String(ports.relay),
        SERVICE_NAME: "transport-relay"
      };
    }
    if (name === "buyer") {
      return {
        ...base,
        PORT: String(ports.buyer),
        SERVICE_NAME: "buyer-controller",
        TRANSPORT_RECEIVER: "buyer-controller"
      };
    }
    return {
      ...base,
      PORT: String(ports.seller),
      SERVICE_NAME: "seller-controller",
      TRANSPORT_RECEIVER: state.config.seller.seller_id || "seller-controller"
    };
  }

  function serviceEntry(name) {
    if (name === "buyer") {
      return require.resolve("@delexec/buyer-controller");
    }
    return require.resolve("@delexec/seller-controller");
  }

  function serviceLaunchSpec(name) {
    if (name === "relay") {
      return relayLaunchSpec();
    }
    return {
      command: process.execPath,
      args: [serviceEntry(name)],
      mode: "node_entry"
    };
  }

  function captureLog(processInfo, line) {
    processInfo.logs.push(line);
    if (processInfo.logs.length > 200) {
      processInfo.logs.shift();
    }
    appendServiceLog(processInfo.name, line);
  }

  async function ensureService(name) {
    const current = runtime.processes.get(name);
    if (current && !current.exited) {
      return current;
    }
    const launch = serviceLaunchSpec(name);
    const child = spawn(launch.command, launch.args, {
      env: serviceEnv(name),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const processInfo = {
      name,
      child,
      logs: [],
      startedAt: nowIso(),
      launchMode: launch.mode,
      exited: false,
      exitedAt: null,
      exitCode: null,
      lastError: null
    };
    child.stdout.on("data", (chunk) => captureLog(processInfo, chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => captureLog(processInfo, chunk.toString("utf8")));
    child.on("error", (error) => {
      processInfo.lastError = error instanceof Error ? error.message : "unknown_error";
      appendSupervisorEvent({
        type: "service_error",
        service: name,
        message: processInfo.lastError
      });
    });
    child.on("exit", (code) => {
      processInfo.exited = true;
      processInfo.exitedAt = nowIso();
      processInfo.exitCode = code;
      appendSupervisorEvent({
        type: "service_exit",
        service: name,
        exit_code: code
      });
    });
    runtime.processes.set(name, processInfo);
    appendSupervisorEvent({
      type: "service_started",
      service: name,
      pid: child.pid
    });
    return processInfo;
  }

  async function ensureBaseServices() {
    if (usesManagedRelay()) {
      await ensureService("relay");
    }
    await ensureService("buyer");
    if (state.config.seller.enabled) {
      await ensureService("seller");
    }
  }

  async function reloadSellerIfRunning() {
    if (!state.config.seller.enabled) {
      return;
    }
    const processInfo = runtime.processes.get("seller");
    if (processInfo && !processInfo.exited) {
      processInfo.child.kill();
    }
    await ensureService("seller");
  }

  async function fetchHealth(name) {
    const port = state.config.runtime.ports[name];
    if (name === "relay" && !usesManagedRelay()) {
      const runtimeTransport = getRuntimeTransport(state);
      if (runtimeTransport.type !== "relay_http") {
        return null;
      }
      try {
        return await requestJson(runtimeTransport.relay_http.base_url, "/healthz");
      } catch (error) {
        return { status: 503, body: { ok: false, error: error instanceof Error ? error.message : "unknown_error" } };
      }
    }
    try {
      return await requestJson(processBaseUrl(port), "/healthz");
    } catch (error) {
      return { status: 503, body: { ok: false, error: error instanceof Error ? error.message : "unknown_error" } };
    }
  }

  async function fetchRecentRequestsSummary() {
    try {
      const response = await requestJson(processBaseUrl(state.config.runtime.ports.buyer), "/controller/requests");
      const items = response.body?.items || [];
      const byStatus = items.reduce((summary, item) => {
        const key = item.status || "UNKNOWN";
        summary[key] = (summary[key] || 0) + 1;
        return summary;
      }, {});
      return {
        total: items.length,
        by_status: byStatus,
        latest: items.slice(0, 5).map((item) => ({
          request_id: item.request_id,
          status: item.status,
          updated_at: item.updated_at || item.created_at || null
        }))
      };
    } catch {
      return {
        total: 0,
        by_status: {},
        latest: []
      };
    }
  }

  async function buildStatus() {
    const subagents = state.config.seller.subagents || [];
    const secrets = getResolvedSecrets(state, runtime);
    const runtimeTransport = getRuntimeTransport(state);
    const pendingReviewCount = subagents.filter((item) => item.submitted_for_review !== true).length;
    const reviewStatusCounts = subagents.reduce((counts, item) => {
      const key = item.review_status || "local_only";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    state.config.buyer.api_key_configured = Boolean(secrets.buyer_api_key);
    state.config.platform_console ||= {};
    state.config.platform_console.admin_api_key_configured = Boolean(secrets.platform_admin_api_key);
    return {
      ok: true,
      config: state.config,
      auth: getAuthState(runtime, state),
      debug: {
        logs_dir: path.join(path.dirname(state.envFile), "logs"),
        event_log: getSupervisorEventsFile(),
        service_logs: {
          relay: getServiceLogFile("relay"),
          buyer: getServiceLogFile("buyer"),
          seller: getServiceLogFile("seller")
        }
      },
      seller: {
        enabled: state.config.seller.enabled,
        seller_id: state.config.seller.seller_id,
        display_name: state.config.seller.display_name,
        subagent_count: subagents.length,
        pending_review_count: pendingReviewCount,
        review_summary: reviewStatusCounts
      },
      requests: await fetchRecentRequestsSummary(),
      runtime: {
        supervisor: {
          port: state.config.runtime.ports.supervisor
        },
        relay: {
          ...getRuntimeStatus("relay"),
          managed: usesManagedRelay(),
          transport_type: runtimeTransport.type,
          base_url: runtimeTransport.type === "relay_http" ? runtimeTransport.relay_http.base_url : processBaseUrl(state.config.runtime.ports.relay),
          health: await fetchHealth("relay")
        },
        buyer: {
          ...getRuntimeStatus("buyer"),
          health: await fetchHealth("buyer")
        },
        seller: {
          ...getRuntimeStatus("seller"),
          health: state.config.seller.enabled ? await fetchHealth("seller") : null
        }
      }
    };
  }

  function buildRuntimeAlerts(service, { maxItems = 20 } = {}) {
    const events = readSupervisorEventTail({ maxLines: 200 })
      .filter((event) => {
        if (service === "supervisor") {
          return true;
        }
        return event.service === service;
      })
      .flatMap((event) => {
        if (event.type === "service_error") {
          return [
            {
              at: event.at,
              service: event.service,
              severity: "error",
              source: "event",
              message: event.message || "service_error"
            }
          ];
        }
        if (event.type === "service_exit" && event.exit_code !== 0 && event.exit_code !== null) {
          return [
            {
              at: event.at,
              service: event.service,
              severity: "error",
              source: "event",
              message: `service exited with code ${event.exit_code}`
            }
          ];
        }
        return [];
      });

    const logAlerts = (service === "supervisor" ? [] : readServiceLogTail(service, { maxLines: 200 }))
      .flatMap((line) => {
        const severity = logSeverity(line);
        if (!severity) {
          return [];
        }
        return [
          {
            at: null,
            service,
            severity,
            source: "log",
            message: line.trim()
          }
        ];
      });

    return [...events, ...logAlerts].slice(-maxItems).reverse();
  }

  async function registerBuyer(contactEmail) {
    const response = await requestJson(state.config.platform.base_url, "/v1/users/register", {
      method: "POST",
      body: {
        contact_email: contactEmail
      }
    });
    if (response.status !== 201) {
      return response;
    }
    state.config.buyer.contact_email = response.body.contact_email || contactEmail;
    state.config.buyer.api_key_configured = true;
    if (hasEncryptedSecretStore()) {
      writeOpsSecrets(runtime.auth.passphrase, {
        [OPS_SECRET_KEYS.buyer_api_key]: response.body.api_key
      });
      runtime.auth.unlockedSecrets = unlockOpsSecrets(runtime.auth.passphrase);
      scrubLegacySecrets(state);
    } else {
      state.env = saveOpsState({
        ...state,
        env: {
          ...state.env,
          BUYER_PLATFORM_API_KEY: response.body.api_key,
          PLATFORM_API_KEY: response.body.api_key
        }
      });
    }
    state.env = saveOpsState(state);
    return response;
  }

  function buildSellerRegisterHeaders() {
    const secrets = getResolvedSecrets(state, runtime);
    const apiKey = secrets.buyer_api_key || secrets.seller_platform_api_key;
    if (!apiKey) {
      throw new Error("buyer_platform_api_key_required");
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  async function submitPendingSellerReviews() {
    const sellerIdentity = ensureSellerIdentity(state);
    const pending = (state.config.seller.subagents || []).filter((item) => item.submitted_for_review !== true);
    const results = [];
    for (const item of pending) {
      const response = await requestJson(state.config.platform.base_url, "/v1/catalog/subagents", {
        method: "POST",
        headers: buildSellerRegisterHeaders(),
        body: {
          seller_id: sellerIdentity.seller_id,
          subagent_id: item.subagent_id,
          display_name: item.display_name || item.subagent_id,
          seller_public_key_pem: sellerIdentity.public_key_pem,
          task_types: item.task_types || [],
          capabilities: item.capabilities || [],
          tags: item.tags || []
        }
      });
      if (response.status !== 201) {
        return response;
      }
      if (hasEncryptedSecretStore()) {
        writeOpsSecrets(runtime.auth.passphrase, {
          [OPS_SECRET_KEYS.seller_platform_api_key]: response.body.seller_api_key || response.body.api_key
        });
        runtime.auth.unlockedSecrets = unlockOpsSecrets(runtime.auth.passphrase);
        scrubLegacySecrets(state);
      } else {
        state.env = saveOpsState({
          ...state,
          env: {
            ...state.env,
            SELLER_PLATFORM_API_KEY: response.body.seller_api_key || response.body.api_key
          }
        });
      }
      item.submitted_for_review = true;
      item.review_status = response.body.subagent_review_status || response.body.review_status || "pending";
      results.push(response.body);
    }
    saveOpsState(state);
    return { status: 201, body: { seller_id: sellerIdentity.seller_id, submitted: results.length, results } };
  }

  async function addOfficialExampleSubagent() {
    const definition = buildExampleSubagentDefinition();
    upsertSubagent(state, definition);
    state.env = saveOpsState(state);
    await reloadSellerIfRunning();
    appendSupervisorEvent({
      type: "subagent_upserted",
      subagent_id: definition.subagent_id,
      adapter_type: definition.adapter_type,
      example: true
    });
    return definition;
  }

  async function dispatchExampleRequest(body = {}) {
    await ensureBaseServices();
    if (!getResolvedSecrets(state, runtime).buyer_api_key) {
      return {
        status: 409,
        body: buildStructuredError("BUYER_NOT_REGISTERED", "buyer must be registered before running the local example", {
          stage: "register_buyer"
        })
      };
    }
    if (state.config.seller.enabled !== true) {
      return {
        status: 409,
        body: buildStructuredError("SELLER_NOT_ENABLED", "seller must be enabled before running the local example", {
          stage: "enable_seller"
        })
      };
    }

    const example = findConfiguredExampleSubagent(state);
    if (!example) {
      return buildExampleVisibilityError(example);
    }
    if (example.submitted_for_review !== true) {
      return buildExampleVisibilityError(example);
    }

    const catalog = await requestJson(
      processBaseUrl(state.config.runtime.ports.buyer),
      `/controller/catalog/subagents?subagent_id=${encodeURIComponent(LOCAL_EXAMPLE_SUBAGENT_ID)}&seller_id=${encodeURIComponent(
        state.config.seller.seller_id || ""
      )}`,
      {
        headers: buildPlatformHeaders(state, runtime)
      }
    );

    const selected = catalog.body?.items?.find(
      (item) => item.subagent_id === LOCAL_EXAMPLE_SUBAGENT_ID && item.seller_id === state.config.seller.seller_id
    );
    if (!selected) {
      return buildExampleVisibilityError(example);
    }

    return requestJson(processBaseUrl(state.config.runtime.ports.buyer), "/controller/remote-requests", {
      method: "POST",
      headers: buildPlatformHeaders(state, runtime),
      body: buildExampleRequestBody({
        text: body.text,
        sellerId: selected.seller_id,
        subagentId: selected.subagent_id,
        signerPublicKeyPem: selected.seller_public_key_pem
      })
    });
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }

      if (isProtectedRoute(method, pathname)) {
        const session = requireAuthenticatedSession(req, res, runtime, state);
        if (!session.ok) {
          return;
        }
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "ops-supervisor" });
        return;
      }
      if (method === "GET" && pathname === "/auth/session") {
        sendJson(res, 200, {
          ok: true,
          session: getAuthState(runtime, state)
        });
        return;
      }
      if (method === "POST" && pathname === "/auth/session/setup") {
        const body = await parseJsonBody(req);
        const passphrase = normalizedString(body.passphrase);
        if (!passphrase || passphrase.length < 8) {
          sendError(res, 400, "AUTH_INVALID_PASSPHRASE", "passphrase must be at least 8 characters");
          return;
        }
        if (hasEncryptedSecretStore()) {
          sendError(res, 409, "AUTH_SECRET_STORE_EXISTS", "encrypted secret store already exists");
          return;
        }
        const legacySecrets = Object.fromEntries(
          Object.entries(readResolvedOpsSecrets(state))
            .flatMap(([key, value]) => {
              if (key === "transport") {
                return [
                  [OPS_SECRET_KEYS.transport_emailengine_access_token, value.emailengine.access_token],
                  [OPS_SECRET_KEYS.transport_gmail_client_secret, value.gmail.client_secret],
                  [OPS_SECRET_KEYS.transport_gmail_refresh_token, value.gmail.refresh_token]
                ];
              }
              return [[key, value]];
            })
            .filter(([, value]) => normalizedString(value))
        );
        initializeSecretStore(state.secretsFile, passphrase, legacySecrets);
        runtime.auth.unlockedSecrets = unlockOpsSecrets(passphrase);
        runtime.auth.passphrase = passphrase;
        runtime.auth.unlockedAt = nowIso();
        state.config.buyer.api_key_configured = Boolean(runtime.auth.unlockedSecrets[OPS_SECRET_KEYS.buyer_api_key]);
        scrubLegacySecrets(state);
        state.env = saveOpsState(state);
        const session = createAuthenticatedSession(runtime, passphrase, runtime.auth.unlockedSecrets);
        appendSupervisorEvent({ type: "auth_session_setup" });
        sendJson(res, 201, {
          ok: true,
          token: session.token,
          expires_at: session.expires_at,
          session: getAuthState(runtime, state)
        });
        return;
      }
      if (method === "POST" && pathname === "/auth/session/login") {
        const body = await parseJsonBody(req);
        const passphrase = normalizedString(body.passphrase);
        if (!passphrase) {
          sendError(res, 400, "AUTH_INVALID_PASSPHRASE", "passphrase is required");
          return;
        }
        if (!hasEncryptedSecretStore()) {
          sendError(res, 409, "AUTH_SECRET_STORE_MISSING", "encrypted secret store is not initialized yet");
          return;
        }
        try {
          const secrets = unlockOpsSecrets(passphrase);
          const session = createAuthenticatedSession(runtime, passphrase, secrets);
          appendSupervisorEvent({ type: "auth_session_login" });
          sendJson(res, 200, {
            ok: true,
            token: session.token,
            expires_at: session.expires_at,
            session: getAuthState(runtime, state)
          });
        } catch (error) {
          sendError(res, 401, "AUTH_INVALID_PASSPHRASE", error instanceof Error ? error.message : "secret_unlock_failed");
        }
        return;
      }
      if (method === "POST" && pathname === "/auth/session/logout") {
        const token = readSessionToken(req);
        if (token) {
          runtime.auth.sessions.delete(token);
        } else {
          runtime.auth.sessions.clear();
        }
        pruneExpiredSessions(runtime);
        appendSupervisorEvent({ type: "auth_session_logout" });
        sendJson(res, 200, {
          ok: true,
          session: getAuthState(runtime, state)
        });
        return;
      }
      if (method === "POST" && pathname === "/auth/session/change-passphrase") {
        if (!hasEncryptedSecretStore()) {
          sendError(res, 409, "AUTH_SECRET_STORE_MISSING", "encrypted secret store is not initialized yet");
          return;
        }
        const body = await parseJsonBody(req);
        const nextPassphrase = normalizedString(body.next_passphrase);
        if (!nextPassphrase || nextPassphrase.length < 8) {
          sendError(res, 400, "AUTH_INVALID_PASSPHRASE", "next_passphrase must be at least 8 characters");
          return;
        }
        const currentPassphrase = runtime.auth.passphrase || normalizedString(body.current_passphrase);
        if (!currentPassphrase) {
          sendError(res, 400, "AUTH_INVALID_PASSPHRASE", "current passphrase is required");
          return;
        }
        try {
          rotateSecretStorePassphrase(state.secretsFile, currentPassphrase, nextPassphrase);
          const secrets = unlockOpsSecrets(nextPassphrase);
          runtime.auth.passphrase = nextPassphrase;
          runtime.auth.unlockedSecrets = secrets;
          runtime.auth.unlockedAt = nowIso();
          appendSupervisorEvent({ type: "auth_passphrase_rotated" });
          sendJson(res, 200, {
            ok: true,
            session: getAuthState(runtime, state)
          });
        } catch (error) {
          sendError(res, 401, "AUTH_INVALID_PASSPHRASE", error instanceof Error ? error.message : "passphrase_rotation_failed");
        }
        return;
      }
      if (method === "GET" && pathname === "/status") {
        sendJson(res, 200, await buildStatus());
        return;
      }
      if (method === "GET" && pathname === "/runtime/transport") {
        sendJson(res, 200, getTransportResponse(state, runtime));
        return;
      }
      if (method === "PUT" && pathname === "/runtime/transport") {
        const body = await parseJsonBody(req);
        const nextTransport = normalizeTransportPayload(body);
        const validation = validateTransportConfig(nextTransport);
        if (validation) {
          sendJson(res, validation.status, validation.body);
          return;
        }
        state.config.runtime ||= {};
        state.config.runtime.transport = nextTransport;
        const secretUpdates = buildTransportSecretUpdates(body);
        if (hasEncryptedSecretStore()) {
          if (Object.keys(secretUpdates).length > 0) {
            writeOpsSecrets(runtime.auth.passphrase, secretUpdates);
            runtime.auth.unlockedSecrets = unlockOpsSecrets(runtime.auth.passphrase);
          }
          scrubLegacySecrets(state);
        } else if (Object.keys(secretUpdates).length > 0) {
          state.env = {
            ...state.env,
            ...buildLegacyTransportSecretEnv(secretUpdates)
          };
        }
        state.env = saveOpsState(state);
        appendSupervisorEvent({
          type: "transport_updated",
          transport_type: nextTransport.type,
          provider: nextTransport.type === "email" ? nextTransport.email.provider : null
        });
        sendJson(res, 200, getTransportResponse(state, runtime));
        return;
      }
      if (method === "POST" && pathname === "/runtime/transport/test") {
        const validation = validateTransportConfig(getRuntimeTransport(state));
        if (validation) {
          sendJson(res, validation.status, validation.body);
          return;
        }
        const result = await testTransportConnection(state, runtime);
        sendJson(res, result.ok ? 200 : result.status || 502, result);
        return;
      }
      if (method === "POST" && pathname === "/setup") {
        ensureSellerIdentity(state);
        state.env = saveOpsState(state);
        appendSupervisorEvent({ type: "setup_completed" });
        sendJson(res, 200, { ok: true, config: state.config });
        return;
      }
      if (method === "POST" && pathname === "/auth/register-buyer") {
        const body = await parseJsonBody(req);
        const registered = await registerBuyer(body.contact_email);
        appendSupervisorEvent({
          type: "buyer_registered",
          ok: registered.status === 201,
          contact_email: body.contact_email || null
        });
        sendJson(res, registered.status, registered.body);
        return;
      }
      if (method === "GET" && pathname === "/catalog/subagents") {
        const response = await requestJson(
          processBaseUrl(state.config.runtime.ports.buyer),
          `/controller/catalog/subagents${url.search}`
        , {
          headers: buildPlatformHeaders(state, runtime)
        });
        sendJson(res, response.status, response.body);
        return;
      }
      if (method === "GET" && pathname === "/requests") {
        const response = await requestJson(processBaseUrl(state.config.runtime.ports.buyer), "/controller/requests");
        sendJson(res, response.status, response.body);
        return;
      }
      const requestMatch = pathname.match(/^\/requests\/([^/]+)$/);
      if (method === "GET" && requestMatch) {
        const response = await requestJson(processBaseUrl(state.config.runtime.ports.buyer), `/controller/requests/${requestMatch[1]}`);
        sendJson(res, response.status, response.body);
        return;
      }
      const requestResultMatch = pathname.match(/^\/requests\/([^/]+)\/result$/);
      if (method === "GET" && requestResultMatch) {
        const response = await requestJson(processBaseUrl(state.config.runtime.ports.buyer), `/controller/requests/${requestResultMatch[1]}/result`);
        sendJson(res, response.status, response.body);
        return;
      }
      if (method === "POST" && pathname === "/requests") {
        const body = await parseJsonBody(req);
        const response = await requestJson(processBaseUrl(state.config.runtime.ports.buyer), "/controller/remote-requests", {
          method: "POST",
          headers: buildPlatformHeaders(state, runtime),
          body
        });
        sendJson(res, response.status, response.body);
        return;
      }
      if (method === "POST" && pathname === "/requests/example") {
        const body = await parseJsonBody(req);
        const response = await dispatchExampleRequest(body);
        sendJson(res, response.status, response.body);
        return;
      }
      if (method === "GET" && pathname === "/seller") {
        sendJson(res, 200, {
          enabled: state.config.seller.enabled,
          seller_id: state.config.seller.seller_id,
          display_name: state.config.seller.display_name,
          subagent_count: (state.config.seller.subagents || []).length,
          subagents: state.config.seller.subagents || []
        });
        return;
      }
      if (method === "GET" && pathname === "/seller/subagents") {
        sendJson(res, 200, { items: state.config.seller.subagents || [] });
        return;
      }
      if (method === "POST" && pathname === "/seller/subagents/example") {
        const definition = await addOfficialExampleSubagent();
        sendJson(res, 201, {
          ...definition,
          example: true,
          message: `${LOCAL_EXAMPLE_DISPLAY_NAME} is configured locally`
        });
        return;
      }
      if (method === "POST" && pathname === "/seller/subagents") {
        const body = await parseJsonBody(req);
        const definition = {
          subagent_id: body.subagent_id,
          display_name: body.display_name || body.subagent_id,
          enabled: body.enabled !== false,
          task_types: body.task_types || [],
          capabilities: body.capabilities || [],
          tags: body.tags || [],
          adapter_type: body.adapter_type || "process",
          adapter: body.adapter || {},
          timeouts: body.timeouts || { soft_timeout_s: 60, hard_timeout_s: 180 },
          review_status: "local_only",
          submitted_for_review: false
        };
        upsertSubagent(state, definition);
        state.env = saveOpsState(state);
        await reloadSellerIfRunning();
        appendSupervisorEvent({
          type: "subagent_upserted",
          subagent_id: definition.subagent_id,
          adapter_type: definition.adapter_type
        });
        sendJson(res, 201, definition);
        return;
      }
      const subagentToggleMatch = pathname.match(/^\/seller\/subagents\/([^/]+)\/(enable|disable)$/);
      if (method === "POST" && subagentToggleMatch) {
        const subagentId = decodeURIComponent(subagentToggleMatch[1]);
        const enabled = subagentToggleMatch[2] === "enable";
        const item = setSubagentEnabled(state, subagentId, enabled);
        if (!item) {
          sendError(res, 404, "subagent_not_found", "no subagent found with this id", { subagent_id: subagentId });
          return;
        }
        state.env = saveOpsState(state);
        await reloadSellerIfRunning();
        appendSupervisorEvent({
          type: "subagent_toggled",
          subagent_id: item.subagent_id,
          enabled: item.enabled !== false
        });
        sendJson(res, 200, {
          ok: true,
          subagent_id: item.subagent_id,
          enabled: item.enabled !== false,
          review_status: item.review_status || "local_only",
          submitted_for_review: item.submitted_for_review === true
        });
        return;
      }
      const subagentDeleteMatch = pathname.match(/^\/seller\/subagents\/([^/]+)$/);
      if (method === "DELETE" && subagentDeleteMatch) {
        const subagentId = decodeURIComponent(subagentDeleteMatch[1]);
        const removed = removeSubagent(state, subagentId);
        if (!removed) {
          sendError(res, 404, "subagent_not_found", "no subagent found with this id", { subagent_id: subagentId });
          return;
        }
        state.env = saveOpsState(state);
        await reloadSellerIfRunning();
        appendSupervisorEvent({
          type: "subagent_removed",
          subagent_id: removed.subagent_id
        });
        sendJson(res, 200, {
          ok: true,
          removed: {
            subagent_id: removed.subagent_id,
            review_status: removed.review_status || "local_only"
          }
        });
        return;
      }
      if (method === "POST" && pathname === "/seller/enable") {
        const body = await parseJsonBody(req);
        ensureSellerIdentity(state, {
          sellerId: body.seller_id || state.config.seller.seller_id || null,
          displayName: body.display_name || state.config.seller.display_name || null
        });
        state.config.seller.enabled = true;
        if (body.subagent_id) {
          upsertSubagent(state, {
            subagent_id: body.subagent_id,
            display_name: body.display_name || body.subagent_id,
            enabled: true,
            task_types: body.task_types || [],
            capabilities: body.capabilities || [],
            tags: body.tags || [],
            adapter_type: body.adapter_type || "process",
            adapter: body.adapter || { cmd: body.cmd || "" },
            timeouts: body.timeouts || { soft_timeout_s: 60, hard_timeout_s: 180 },
            review_status: "local_only",
            submitted_for_review: false
          });
        }
        state.env = saveOpsState(state);
        await ensureService("seller");
        appendSupervisorEvent({
          type: "seller_enabled",
          seller_id: state.config.seller.seller_id
        });
        sendJson(res, 200, {
          ok: true,
          seller: state.config.seller,
          submitted: 0,
          review: null
        });
        return;
      }
      if (method === "POST" && pathname === "/seller/submit-review") {
        const body = await parseJsonBody(req);
        ensureSellerIdentity(state, {
          sellerId: body.seller_id || state.config.seller.seller_id || null,
          displayName: body.display_name || state.config.seller.display_name || null
        });
        state.env = saveOpsState(state);
        const submitted = await submitPendingSellerReviews();
        await reloadSellerIfRunning();
        appendSupervisorEvent({
          type: "seller_review_submitted",
          seller_id: state.config.seller.seller_id,
          submitted: submitted.body?.submitted || 0,
          ok: submitted.status === 201
        });
        sendJson(res, submitted.status, submitted.body);
        return;
      }
      if (method === "GET" && pathname === "/runtime/logs") {
        const service = url.searchParams.get("service");
        if (!service) {
          sendError(res, 400, "service_required", "service query parameter is required");
          return;
        }
        const maxLines = Number(url.searchParams.get("max_lines") || 200);
        sendJson(res, 200, {
          service,
          file: getServiceLogFile(service),
          logs: readServiceLogTail(service, { maxLines })
        });
        return;
      }
      if (method === "GET" && pathname === "/runtime/alerts") {
        const service = url.searchParams.get("service");
        if (!service) {
          sendError(res, 400, "service_required", "service query parameter is required");
          return;
        }
        const maxItems = Number(url.searchParams.get("max_items") || 20);
        sendJson(res, 200, {
          service,
          alerts: buildRuntimeAlerts(service, { maxItems })
        });
        return;
      }
      if (method === "GET" && pathname === "/debug/snapshot") {
        const status = await buildStatus();
        sendJson(res, 200, {
          ok: true,
          generated_at: nowIso(),
          status,
          recent_events: readSupervisorEventTail({ maxLines: 50 }),
          log_tail: {
            relay: readServiceLogTail("relay", { maxLines: 50 }),
            buyer: readServiceLogTail("buyer", { maxLines: 50 }),
            seller: readServiceLogTail("seller", { maxLines: 50 })
          }
        });
        return;
      }

      sendError(res, 404, "not_found", "no matching route", { path: pathname });
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_json") {
        sendError(res, 400, "invalid_json", "request body is not valid JSON");
        return;
      }
      sendError(res, 500, "ops_supervisor_internal_error", error instanceof Error ? error.message : "unknown_error", { retryable: true });
    }
  });

  server.startManagedServices = async () => {
    ensureSellerIdentity(state);
    state.env = saveOpsState(state);
    await ensureBaseServices();
    appendSupervisorEvent({ type: "managed_services_started" });
  };

  server.stopManagedServices = async () => {
    for (const processInfo of runtime.processes.values()) {
      if (!processInfo.exited) {
        processInfo.child.kill();
      }
    }
    appendSupervisorEvent({ type: "managed_services_stopped" });
  };

  return server;
}
