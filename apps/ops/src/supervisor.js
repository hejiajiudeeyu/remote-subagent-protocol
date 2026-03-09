import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

import { ensureSellerIdentity, ensureOpsState, removeSubagent, saveOpsState, setSubagentEnabled, upsertSubagent } from "./config.js";
import {
  appendServiceLog,
  appendSupervisorEvent,
  getServiceLogFile,
  getSupervisorEventsFile,
  readServiceLogTail,
  readSupervisorEventTail
} from "./logging.js";

const require = createRequire(import.meta.url);

function nowIso() {
  return new Date().toISOString();
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, code, message, { retryable = false, ...extra } = {}) {
  sendJson(res, statusCode, { error: { code, message, retryable }, ...extra });
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
    processes: new Map()
  };

  function getRuntimeStatus(name) {
    const processInfo = runtime.processes.get(name);
    if (!processInfo) {
      return {
        name,
        running: false,
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
      pid: processInfo.child.pid,
      started_at: processInfo.startedAt,
      exited_at: processInfo.exitedAt,
      exit_code: processInfo.exitCode,
      last_error: processInfo.lastError
    };
  }

  function serviceEnv(name) {
    const ports = state.config.runtime.ports;
    const relayBaseUrl = state.config.runtime.external_relay?.base_url || processBaseUrl(ports.relay);
    const base = {
      ...process.env,
      CROC_OPS_HOME: process.env.CROC_OPS_HOME || path.dirname(state.envFile),
      PLATFORM_API_BASE_URL: state.config.platform.base_url,
      BUYER_PLATFORM_API_KEY: state.config.buyer.api_key || "",
      PLATFORM_API_KEY: state.config.buyer.api_key || "",
      BUYER_CONTACT_EMAIL: state.config.buyer.contact_email || "",
      SELLER_ID: state.config.seller.seller_id || "",
      SELLER_SIGNING_PUBLIC_KEY_PEM: state.env.SELLER_SIGNING_PUBLIC_KEY_PEM || "",
      SELLER_SIGNING_PRIVATE_KEY_PEM: state.env.SELLER_SIGNING_PRIVATE_KEY_PEM || "",
      SUBAGENT_IDS: (state.config.seller.subagents || []).map((item) => item.subagent_id).join(","),
      SELLER_PLATFORM_API_KEY: state.env.SELLER_PLATFORM_API_KEY || "",
      TRANSPORT_BASE_URL: relayBaseUrl
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
    if (name === "relay") {
      return require.resolve("@croc/transport-relay");
    }
    if (name === "buyer") {
      return require.resolve("@croc/buyer-controller");
    }
    return require.resolve("@croc/seller-controller");
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
    const child = spawn(process.execPath, [serviceEntry(name)], {
      env: serviceEnv(name),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const processInfo = {
      name,
      child,
      logs: [],
      startedAt: nowIso(),
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
    await ensureService("relay");
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
    const pendingReviewCount = subagents.filter((item) => item.submitted_for_review !== true).length;
    const reviewStatusCounts = subagents.reduce((counts, item) => {
      const key = item.review_status || "local_only";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {});
    return {
      ok: true,
      config: state.config,
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
    state.config.buyer.api_key = response.body.api_key;
    state.config.buyer.contact_email = response.body.contact_email || contactEmail;
    state.env = saveOpsState(state);
    return response;
  }

  function buildSellerRegisterHeaders() {
    const apiKey = state.config.buyer.api_key || state.env.SELLER_PLATFORM_API_KEY || state.env.PLATFORM_API_KEY;
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
      const response = await requestJson(state.config.platform.base_url, "/v1/sellers/register", {
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
      state.env = saveOpsState({
        ...state,
        env: {
          ...state.env,
          SELLER_PLATFORM_API_KEY: response.body.api_key
        }
      });
      state.env.SELLER_PLATFORM_API_KEY = response.body.api_key;
      item.submitted_for_review = true;
      item.review_status = response.body.review_status || "pending";
      results.push(response.body);
    }
    saveOpsState(state);
    return { status: 201, body: { seller_id: sellerIdentity.seller_id, submitted: results.length, results } };
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

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "ops-supervisor" });
        return;
      }
      if (method === "GET" && pathname === "/status") {
        sendJson(res, 200, await buildStatus());
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
          headers: state.config.buyer.api_key ? { "X-Platform-Api-Key": state.config.buyer.api_key } : {}
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
          headers: state.config.buyer.api_key ? { "X-Platform-Api-Key": state.config.buyer.api_key } : {},
          body
        });
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
