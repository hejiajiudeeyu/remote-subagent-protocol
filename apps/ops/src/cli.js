#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { createOpsSupervisorServer } from "./supervisor.js";
import { ensureOpsState, ensureSellerIdentity, removeSubagent, saveOpsState, setSubagentEnabled, upsertSubagent } from "./config.js";

function usage() {
  console.log(`Usage:
  croc-ops setup
  croc-ops start
  croc-ops status
  croc-ops auth register --email <email> [--platform <url>]
  croc-ops enable-seller [--seller-id <id>] [--display-name <name>]
  croc-ops add-subagent --type <process|http> --subagent-id <id> [options]
  croc-ops remove-subagent --subagent-id <id>
  croc-ops enable-subagent --subagent-id <id>
  croc-ops disable-subagent --subagent-id <id>
  croc-ops submit-review
  croc-ops doctor
  croc-ops debug-snapshot

Compatibility:
  croc-ops seller init
  croc-ops seller register
  croc-ops seller add-subagent ...
  croc-ops seller start
  croc-ops seller status
  croc-ops seller doctor`);
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
    const response = await requestJson(state.config.platform.base_url, "/v1/sellers/register", {
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
    state.env.SELLER_PLATFORM_API_KEY = response.body.api_key;
    item.submitted_for_review = true;
    item.review_status = response.body.review_status || "pending";
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
  if (group === "enable-seller") {
    await commandEnableSeller(args);
    return;
  }
  if (group === "add-subagent") {
    await commandAddSubagent(args);
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
  console.error(`[croc-ops] ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
