#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createOpsSupervisorServer } from "./supervisor.js";
import { ensureOpsState, ensureSellerIdentity, removeSubagent, saveOpsState, setSubagentEnabled, upsertSubagent } from "./config.js";
import { buildExampleSubagentDefinition, LOCAL_EXAMPLE_SUBAGENT_ID } from "./example-subagent.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(import.meta.url);

function usage() {
  console.log(`Usage:
  delexec-ops setup
  delexec-ops start
  delexec-ops status
  delexec-ops bootstrap [--email <email>] [--platform <url>] [--text <text>]
  delexec-ops auth register --email <email> [--platform <url>]
  delexec-ops enable-seller [--seller-id <id>] [--display-name <name>]
  delexec-ops add-subagent --type <process|http> --subagent-id <id> [options]
  delexec-ops add-example-subagent
  delexec-ops remove-subagent --subagent-id <id>
  delexec-ops enable-subagent --subagent-id <id>
  delexec-ops disable-subagent --subagent-id <id>
  delexec-ops submit-review
  delexec-ops run-example [--text <text>]
  delexec-ops doctor
  delexec-ops debug-snapshot

Compatibility:
  delexec-ops seller init
  delexec-ops seller register
  delexec-ops seller add-subagent ...
  delexec-ops seller start
  delexec-ops seller status
  delexec-ops seller doctor`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) {
      index += 1;
    }
    if (args[key] === undefined) {
      args[key] = value;
    } else if (Array.isArray(args[key])) {
      args[key].push(value);
    } else {
      args[key] = [args[key], value];
    }
  }
  return args;
}

function emit(value) {
  console.log(JSON.stringify(value, null, 2));
}

function logBootstrapStep(steps, step, ok, detail = {}) {
  steps.push({ step, ok, ...detail });
}

function getValues(value) {
  if (value === undefined || value === null || value === false) {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
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

async function runCliSubcommand(args, env) {
  const result = await execFileAsync(process.execPath, [CLI_PATH, ...args], { env });
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

async function waitFor(check, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await check();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timeout");
}

function buildSellerRegisterHeaders(state) {
  const apiKey = state.config.buyer.api_key || state.env.SELLER_PLATFORM_API_KEY || state.env.PLATFORM_API_KEY;
  if (!apiKey) {
    throw new Error("buyer_platform_api_key_required");
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function parseSubagentDefinition(args) {
  const type = String(args.type || "process");
  const subagentId = String(args["subagent-id"] || "").trim();
  if (!subagentId) {
    throw new Error("subagent_id_required");
  }
  const definition = {
    subagent_id: subagentId,
    display_name: String(args["display-name"] || subagentId),
    enabled: true,
    task_types: getValues(args["task-type"]),
    capabilities: getValues(args.capability),
    tags: getValues(args.tag),
    adapter_type: type,
    timeouts: {
      soft_timeout_s: Number(args["soft-timeout-s"] || 60),
      hard_timeout_s: Number(args["hard-timeout-s"] || 180)
    },
    review_status: "local_only",
    submitted_for_review: false
  };
  if (type === "http") {
    const url = String(args.url || "").trim();
    if (!url) {
      throw new Error("http_adapter_url_required");
    }
    definition.adapter = {
      url,
      method: String(args.method || "POST").toUpperCase()
    };
    return definition;
  }
  const cmd = String(args.cmd || "").trim();
  if (!cmd) {
    throw new Error("process_adapter_cmd_required");
  }
  definition.adapter = {
    cmd,
    cwd: args.cwd ? String(args.cwd) : undefined,
    env: {}
  };
  return definition;
}

function supervisorUrlFromState(state) {
  return `http://127.0.0.1:${state.config.runtime.ports.supervisor}`;
}

async function ensureSupervisorAvailable(baseUrl, env) {
  try {
    const health = await requestJson(baseUrl, "/healthz");
    if (health.status === 200) {
      return { started: false };
    }
  } catch {}

  const child = spawn(process.execPath, [CLI_PATH, "start"], {
    env,
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  await waitFor(async () => {
    const health = await requestJson(baseUrl, "/healthz");
    if (health.status !== 200) {
      throw new Error("supervisor_not_ready");
    }
    return health;
  });
  return { started: true };
}

async function maybeApproveExample({ platformUrl, adminApiKey, sellerId }) {
  if (!adminApiKey) {
    return { ok: false, reason: "admin_api_key_missing" };
  }
  const headers = { Authorization: `Bearer ${adminApiKey}` };
  const seller = await requestJson(platformUrl, `/v1/admin/sellers/${encodeURIComponent(sellerId)}/approve`, {
    method: "POST",
    headers,
    body: { reason: "ops bootstrap local demo approval" }
  });
  const subagent = await requestJson(platformUrl, `/v1/admin/subagents/${encodeURIComponent(LOCAL_EXAMPLE_SUBAGENT_ID)}/approve`, {
    method: "POST",
    headers,
    body: { reason: "ops bootstrap local demo approval" }
  });
  return {
    ok: seller.status === 200 && subagent.status === 200,
    seller,
    subagent
  };
}

async function waitForCatalogVisibility(supervisorUrl, sellerId, options) {
  return waitFor(async () => {
    const catalog = await requestJson(
      supervisorUrl,
      `/catalog/subagents?subagent_id=${encodeURIComponent(LOCAL_EXAMPLE_SUBAGENT_ID)}&seller_id=${encodeURIComponent(sellerId)}`
    );
    const item = catalog.body?.items?.find(
      (entry) => entry.subagent_id === LOCAL_EXAMPLE_SUBAGENT_ID && entry.seller_id === sellerId
    );
    if (!item) {
      throw new Error("catalog_not_ready");
    }
    return item;
  }, options);
}

async function commandSetup(args = {}) {
  const state = ensureOpsState();
  ensureSellerIdentity(state, {
    sellerId: args["seller-id"] ? String(args["seller-id"]) : null,
    displayName: args["display-name"] ? String(args["display-name"]) : null
  });
  state.env = saveOpsState(state);
  emit({
    ok: true,
    ops_home: path.dirname(state.envFile),
    env_file: state.envFile,
    config_file: state.opsConfigFile,
    config: state.config
  });
}

async function commandStart() {
  const state = ensureOpsState();
  ensureSellerIdentity(state);
  state.env = saveOpsState(state);
  const server = createOpsSupervisorServer();
  await new Promise((resolve) => server.listen(state.config.runtime.ports.supervisor, "127.0.0.1", resolve));
  await server.startManagedServices();
  console.log(`[ops-supervisor] listening on ${state.config.runtime.ports.supervisor}`);
  server.on("close", () => {
    void server.stopManagedServices();
  });
}

async function commandStatus() {
  const state = ensureOpsState();
  try {
    const response = await requestJson(supervisorUrlFromState(state), "/status");
    emit(response.body);
  } catch {
    emit({
      ok: false,
      running: false,
      config: state.config
    });
  }
}

async function commandAuthRegister(args) {
  const state = ensureOpsState();
  if (args.platform) {
    state.config.platform.base_url = String(args.platform).trim();
    state.env = saveOpsState(state);
  }
  const email = String(args.email || "").trim();
  if (!email) {
    throw new Error("email_required");
  }
  const response = await requestJson(supervisorUrlFromState(state), "/auth/register-buyer", {
    method: "POST",
    body: { contact_email: email }
  }).catch(async () => {
    const local = ensureOpsState();
    local.config.platform.base_url = String(args.platform || local.config.platform.base_url).trim();
    const direct = await requestJson(local.config.platform.base_url, "/v1/users/register", {
      method: "POST",
      body: { contact_email: email }
    });
    if (direct.status === 201) {
      local.config.buyer.api_key = direct.body.api_key;
      local.config.buyer.contact_email = direct.body.contact_email || email;
      local.env = saveOpsState(local);
    }
    return direct;
  });
  emit({
    ok: response.status === 201,
    ...response.body
  });
}

async function commandEnableSeller(args) {
  const state = ensureOpsState();
  state.config.seller.enabled = true;
  ensureSellerIdentity(state, {
    sellerId: args["seller-id"] ? String(args["seller-id"]) : null,
    displayName: args["display-name"] ? String(args["display-name"]) : null
  });
  state.env = saveOpsState(state);
  try {
    const response = await requestJson(supervisorUrlFromState(state), "/seller/enable", {
      method: "POST",
      body: {
        seller_id: state.config.seller.seller_id,
        display_name: state.config.seller.display_name
      }
    });
    emit(response.body);
  } catch {
    emit({
      ok: true,
      seller: state.config.seller,
      submitted: 0,
      review: null
    });
  }
}

async function commandAddSubagent(args) {
  const state = ensureOpsState();
  const definition = parseSubagentDefinition(args);
  upsertSubagent(state, definition);
  state.env = saveOpsState(state);
  try {
    await requestJson(supervisorUrlFromState(state), "/seller/subagents", {
      method: "POST",
      body: definition
    });
  } catch {}
  emit({
    ok: true,
    subagent_id: definition.subagent_id,
    adapter_type: definition.adapter_type
  });
}

async function commandAddExampleSubagent() {
  const state = ensureOpsState();
  const definition = buildExampleSubagentDefinition();
  upsertSubagent(state, definition);
  state.env = saveOpsState(state);
  try {
    const response = await requestJson(supervisorUrlFromState(state), "/seller/subagents/example", {
      method: "POST",
      body: {}
    });
    emit(response.body);
    return;
  } catch {}
  emit({
    ok: true,
    example: true,
    subagent_id: definition.subagent_id,
    adapter_type: definition.adapter_type
  });
}

async function commandSetSubagentEnabled(args, enabled) {
  const state = ensureOpsState();
  const subagentId = String(args["subagent-id"] || "").trim();
  if (!subagentId) {
    throw new Error("subagent_id_required");
  }
  const item = setSubagentEnabled(state, subagentId, enabled);
  if (!item) {
    throw new Error("subagent_not_found");
  }
  state.env = saveOpsState(state);
  try {
    const response = await requestJson(
      supervisorUrlFromState(state),
      `/seller/subagents/${encodeURIComponent(subagentId)}/${enabled ? "enable" : "disable"}`,
      {
        method: "POST",
        body: {}
      }
    );
    emit(response.body);
    return;
  } catch {}
  emit({
    ok: true,
    subagent_id: item.subagent_id,
    enabled: item.enabled !== false
  });
}

async function commandRemoveSubagent(args) {
  const state = ensureOpsState();
  const subagentId = String(args["subagent-id"] || "").trim();
  if (!subagentId) {
    throw new Error("subagent_id_required");
  }
  const item = removeSubagent(state, subagentId);
  if (!item) {
    throw new Error("subagent_not_found");
  }
  state.env = saveOpsState(state);
  try {
    const response = await requestJson(supervisorUrlFromState(state), `/seller/subagents/${encodeURIComponent(subagentId)}`, {
      method: "DELETE"
    });
    emit(response.body);
    return;
  } catch {}
  emit({
    ok: true,
    removed: {
      subagent_id: item.subagent_id
    }
  });
}

async function commandSubmitReview(args = {}) {
  const state = ensureOpsState();
  const sellerIdentity = ensureSellerIdentity(state, {
    sellerId: args["seller-id"] ? String(args["seller-id"]) : null,
    displayName: args["display-name"] ? String(args["display-name"]) : null
  });
  state.env = saveOpsState(state);
  try {
    const response = await requestJson(supervisorUrlFromState(state), "/seller/submit-review", {
      method: "POST",
      body: {
        seller_id: state.config.seller.seller_id,
        display_name: state.config.seller.display_name
      }
    });
    emit(response.body);
    return;
  } catch {}

  const pending = (state.config.seller.subagents || []).filter((item) => item.submitted_for_review !== true);
  const results = [];
  for (const item of pending) {
    const response = await requestJson(state.config.platform.base_url, "/v1/catalog/subagents", {
      method: "POST",
      headers: buildSellerRegisterHeaders(state),
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
      emit(response.body);
      return;
    }
    state.env.SELLER_PLATFORM_API_KEY = response.body.seller_api_key || response.body.api_key;
    item.submitted_for_review = true;
    item.review_status = response.body.subagent_review_status || response.body.review_status || "pending";
    results.push(response.body);
  }
  state.env = saveOpsState(state);
  emit({
    ok: true,
    seller_id: state.config.seller.seller_id,
    submitted: results.length,
    results
  });
}

async function commandDoctor() {
  const state = ensureOpsState();
  const adapterChecks = (state.config.seller.subagents || []).map((item) => {
    if (item.adapter_type === "http") {
      const valid = typeof item.adapter?.url === "string" && item.adapter.url.startsWith("http");
      return {
        subagent_id: item.subagent_id,
        adapter_type: item.adapter_type,
        ok: valid,
        detail: valid ? item.adapter.url : "invalid_http_url"
      };
    }
    const cmd = String(item.adapter?.cmd || "").trim();
    const firstToken = cmd.split(/\s+/).filter(Boolean)[0] || "";
    const isAbsolute = firstToken.startsWith("/");
    const valid = Boolean(cmd) && (!isAbsolute || fs.existsSync(firstToken));
    return {
      subagent_id: item.subagent_id,
      adapter_type: item.adapter_type || "process",
      ok: valid,
      detail: valid ? cmd : "process_command_missing_or_not_found"
    };
  });
  try {
    const response = await requestJson(supervisorUrlFromState(state), "/status");
    emit({
      ok: true,
      checks: response.body.runtime,
      debug: response.body.debug,
      adapters: adapterChecks
    });
  } catch (error) {
    emit({
      ok: false,
      message: error instanceof Error ? error.message : "unknown_error",
      config: state.config,
      adapters: adapterChecks
    });
  }
}

async function commandDebugSnapshot() {
  const state = ensureOpsState();
  const response = await requestJson(supervisorUrlFromState(state), "/debug/snapshot");
  emit(response.body);
}

async function commandRunExample(args) {
  const state = ensureOpsState();
  const text = String(args.text || "Summarize this local example request.").trim();
  const response = await requestJson(supervisorUrlFromState(state), "/requests/example", {
    method: "POST",
    body: { text }
  });
  emit({
    ok: response.status === 201,
    ...response.body
  });
}

async function commandBootstrap(args) {
  const steps = [];
  const initialState = ensureOpsState();
  const setupArgs = ["setup"];
  if (args["seller-id"]) {
    setupArgs.push("--seller-id", String(args["seller-id"]));
  }
  if (args["display-name"]) {
    setupArgs.push("--display-name", String(args["display-name"]));
  }

  const platformUrl = String(args.platform || initialState.config.platform.base_url || process.env.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080").trim();
  const env = { ...process.env, PLATFORM_API_BASE_URL: platformUrl };

  try {
    const setup = await runCliSubcommand(setupArgs, env);
    logBootstrapStep(steps, "setup_ok", true, { ops_home: setup.ops_home });

    let state = ensureOpsState();
    const email =
      String(args.email || state.config.buyer.contact_email || process.env.BOOTSTRAP_BUYER_EMAIL || "").trim() ||
      `ops-user-${Date.now()}@local.test`;
    if (state.config.buyer.api_key && state.config.buyer.contact_email) {
      logBootstrapStep(steps, "buyer_registered", true, {
        buyer_email: state.config.buyer.contact_email,
        existing: true
      });
    } else {
      const register = await runCliSubcommand(["auth", "register", "--email", email, "--platform", platformUrl], env);
      logBootstrapStep(steps, "buyer_registered", register.ok === true, {
        buyer_email: register.contact_email || email
      });
      if (register.ok !== true) {
        emit({
          ok: false,
          stage: "buyer_register_failed",
          steps,
          response: register
        });
        return;
      }
    }

    state = ensureOpsState();
    const hasExample = (state.config.seller.subagents || []).some((item) => item.subagent_id === LOCAL_EXAMPLE_SUBAGENT_ID);
    if (hasExample) {
      logBootstrapStep(steps, "example_subagent_added", true, {
        subagent_id: LOCAL_EXAMPLE_SUBAGENT_ID,
        existing: true
      });
    } else {
      const added = await runCliSubcommand(["add-example-subagent"], env);
      logBootstrapStep(steps, "example_subagent_added", added.ok !== false, {
        subagent_id: added.subagent_id || LOCAL_EXAMPLE_SUBAGENT_ID
      });
      if (added.ok === false) {
        emit({
          ok: false,
          stage: "example_subagent_add_failed",
          steps,
          response: added
        });
        return;
      }
    }

    state = ensureOpsState();
    const example = (state.config.seller.subagents || []).find((item) => item.subagent_id === LOCAL_EXAMPLE_SUBAGENT_ID);
    if (example?.submitted_for_review === true) {
      logBootstrapStep(steps, "review_submitted", true, {
        submitted: 0,
        existing: true
      });
    } else {
      const review = await runCliSubcommand(["submit-review"], env);
      const reviewOk = review.ok === true || typeof review.submitted === "number";
      logBootstrapStep(steps, "review_submitted", reviewOk, {
        submitted: review.submitted || 0
      });
      if (!reviewOk) {
        emit({
          ok: false,
          stage: "submit_review_failed",
          steps,
          response: review
        });
        return;
      }
    }

    const enabled = await runCliSubcommand(["enable-seller"], env);
    const sellerId = enabled.seller?.seller_id || enabled.seller_id || ensureOpsState().config.seller.seller_id;
    logBootstrapStep(steps, "seller_enabled", enabled.ok === true, { seller_id: sellerId });
    if (enabled.ok !== true) {
      emit({
        ok: false,
        stage: "enable_seller_failed",
        steps,
        response: enabled
      });
      return;
    }

    const supervisorUrl = supervisorUrlFromState(ensureOpsState());
    const supervisor = await ensureSupervisorAvailable(supervisorUrl, env);
    logBootstrapStep(steps, "supervisor_started", true, supervisor);

    let catalogVisible = null;
    try {
      catalogVisible = await waitForCatalogVisibility(supervisorUrl, sellerId, {
        timeoutMs: 750,
        intervalMs: 150
      });
    } catch {}

    if (!catalogVisible) {
      const approved = await maybeApproveExample({
        platformUrl,
        adminApiKey: process.env.PLATFORM_ADMIN_API_KEY || process.env.ADMIN_API_KEY || null,
        sellerId
      });
      if (!approved.ok) {
        emit({
          ok: false,
          stage: "awaiting_admin_approval",
          steps,
          seller_id: sellerId,
          subagent_id: LOCAL_EXAMPLE_SUBAGENT_ID,
          next_action: "Approve seller and subagent, then rerun delexec-ops bootstrap or delexec-ops run-example.",
          reason: approved.reason || "approval_failed"
        });
        return;
      }
      logBootstrapStep(steps, "seller_approved", true);
      logBootstrapStep(steps, "subagent_approved", true);
      catalogVisible = await waitForCatalogVisibility(supervisorUrl, sellerId, {
        timeoutMs: 15000,
        intervalMs: 250
      });
    }
    logBootstrapStep(steps, "catalog_visible", true, { subagent_id: LOCAL_EXAMPLE_SUBAGENT_ID });

    const started = await requestJson(supervisorUrl, "/requests/example", {
      method: "POST",
      body: {
        text: String(args.text || process.env.BOOTSTRAP_EXAMPLE_TEXT || "Summarize this bootstrap request.").trim()
      }
    });
    if (started.status !== 201 || !started.body?.request_id) {
      emit({
        ok: false,
        stage: "request_start_failed",
        steps,
        response: started.body || started
      });
      return;
    }

    const requestId = started.body.request_id;
    const final = await waitFor(async () => {
      const current = await requestJson(supervisorUrl, `/requests/${encodeURIComponent(requestId)}`);
      if (!["SUCCEEDED", "FAILED", "UNVERIFIED", "TIMED_OUT"].includes(current.body?.status)) {
        throw new Error("request_not_ready");
      }
      return current.body;
    });
    logBootstrapStep(steps, "request_succeeded", final.status === "SUCCEEDED", {
      request_id: requestId,
      status: final.status
    });

    emit({
      ok: final.status === "SUCCEEDED",
      request_id: requestId,
      status: final.status,
      seller_id: sellerId,
      subagent_id: LOCAL_EXAMPLE_SUBAGENT_ID,
      supervisor_url: supervisorUrl,
      steps
    });
  } catch (error) {
    emit({
      ok: false,
      stage: "bootstrap_failed",
      steps,
      error: error instanceof Error ? error.message : "unknown_error"
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args._.length === 0) {
    usage();
    process.exit(args._.length === 0 ? 1 : 0);
  }

  const [group, command] = args._;

  if (group === "setup") {
    await commandSetup(args);
    return;
  }
  if (group === "start") {
    await commandStart();
    return;
  }
  if (group === "status") {
    await commandStatus();
    return;
  }
  if (group === "bootstrap") {
    await commandBootstrap(args);
    return;
  }
  if (group === "enable-seller") {
    await commandEnableSeller(args);
    return;
  }
  if (group === "add-subagent") {
    await commandAddSubagent(args);
    return;
  }
  if (group === "add-example-subagent") {
    await commandAddExampleSubagent();
    return;
  }
  if (group === "enable-subagent") {
    await commandSetSubagentEnabled(args, true);
    return;
  }
  if (group === "remove-subagent") {
    await commandRemoveSubagent(args);
    return;
  }
  if (group === "disable-subagent") {
    await commandSetSubagentEnabled(args, false);
    return;
  }
  if (group === "doctor") {
    await commandDoctor();
    return;
  }
  if (group === "debug-snapshot") {
    await commandDebugSnapshot();
    return;
  }
  if (group === "submit-review") {
    await commandSubmitReview(args);
    return;
  }
  if (group === "run-example") {
    await commandRunExample(args);
    return;
  }
  if (group === "auth" && command === "register") {
    await commandAuthRegister(args);
    return;
  }

  if (group === "seller" && command === "init") {
    await commandSetup(args);
    return;
  }
  if (group === "seller" && command === "register") {
    await commandSubmitReview(args);
    return;
  }
  if (group === "seller" && command === "add-subagent") {
    await commandAddSubagent(args);
    return;
  }
  if (group === "seller" && command === "enable-subagent") {
    await commandSetSubagentEnabled(args, true);
    return;
  }
  if (group === "seller" && command === "remove-subagent") {
    await commandRemoveSubagent(args);
    return;
  }
  if (group === "seller" && command === "disable-subagent") {
    await commandSetSubagentEnabled(args, false);
    return;
  }
  if (group === "seller" && command === "start") {
    await commandStart();
    return;
  }
  if (group === "seller" && command === "status") {
    await commandStatus();
    return;
  }
  if (group === "seller" && command === "doctor") {
    await commandDoctor();
    return;
  }
  if (group === "seller" && command === "debug-snapshot") {
    await commandDebugSnapshot();
    return;
  }

  usage();
  throw new Error(`unsupported_command:${group || ""}:${command || ""}`);
}

main().catch((error) => {
  console.error(`[delexec-ops] ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
