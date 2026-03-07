import crypto from "node:crypto";
import http from "node:http";

import { canonicalizeResultPackageForSignature } from "../../contracts/src/index.js";

export const BUYER_TERMINAL_STATUSES = Object.freeze(["SUCCEEDED", "FAILED", "UNVERIFIED", "TIMED_OUT"]);
export const BUYER_ACTIVE_STATUSES = Object.freeze(["CREATED", "SENT", "ACKED"]);

const TERMINAL_STATUS_SET = new Set(BUYER_TERMINAL_STATUSES);
const ACTIVE_STATUS_SET = new Set(BUYER_ACTIVE_STATUSES);

function nowIso() {
  return new Date().toISOString();
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

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization, X-Platform-Api-Key"
  });
  res.end(JSON.stringify(data));
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
    headers: response.headers,
    body: text ? JSON.parse(text) : null
  };
}

function createUpstreamError(code, response) {
  const error = new Error(code);
  error.code = code;
  error.response = response;
  return error;
}

function sendUpstreamError(res, error, fallbackError) {
  if (error?.response) {
    sendJson(res, error.response.status, error.response.body || { error: fallbackError });
    return;
  }

  sendJson(res, 502, {
    error: fallbackError,
    message: error instanceof Error ? error.message : "unknown_error"
  });
}

export function loadBuyerConfig() {
  return {
    ack_deadline_s: Number(process.env.ACK_DEADLINE_S || 120),
    timeout_confirmation_mode: process.env.TIMEOUT_CONFIRMATION_MODE || "ask_by_default",
    hard_timeout_auto_finalize: String(process.env.HARD_TIMEOUT_AUTO_FINALIZE || "true") === "true",
    poll_interval_active_s: Number(process.env.BUYER_CONTROLLER_POLL_INTERVAL_ACTIVE_S || 5),
    poll_interval_backoff_s: Number(process.env.BUYER_CONTROLLER_POLL_INTERVAL_BACKOFF_S || 15)
  };
}

export function createBuyerState() {
  return { requests: new Map() };
}

export function serializeBuyerState(state) {
  return {
    requests: Array.from(state.requests.entries())
  };
}

export function hydrateBuyerState(state, snapshot) {
  if (!snapshot) {
    return state;
  }

  state.requests.clear();
  for (const [requestId, request] of snapshot.requests || []) {
    state.requests.set(requestId, request);
  }
  return state;
}

export function createBuyerPlatformClient({ baseUrl, apiKey } = {}) {
  if (!baseUrl) {
    throw new Error("buyer_platform_base_url_required");
  }

  function authHeaders(required = false) {
    if (!apiKey) {
      if (required) {
        throw new Error("buyer_platform_api_key_required");
      }
      return {};
    }

    return {
      Authorization: `Bearer ${apiKey}`
    };
  }

  return {
    async listCatalogSubagents(filters = {}) {
      const params = new URLSearchParams();
      if (filters.status) {
        params.set("status", filters.status);
      }
      if (filters.availability_status) {
        params.set("availability_status", filters.availability_status);
      }

      const pathname = `/v1/catalog/subagents${params.size > 0 ? `?${params.toString()}` : ""}`;
      const response = await requestJson(baseUrl, pathname, {
        headers: authHeaders(false)
      });
      if (response.status !== 200) {
        throw createUpstreamError("BUYER_PLATFORM_CATALOG_FAILED", response);
      }

      let items = response.body?.items || [];
      if (filters.seller_id) {
        items = items.filter((item) => item.seller_id === filters.seller_id);
      }
      if (filters.subagent_id) {
        items = items.filter((item) => item.subagent_id === filters.subagent_id);
      }

      return {
        ...response.body,
        items
      };
    },

    async issueTaskToken({ requestId, sellerId, subagentId }) {
      const response = await requestJson(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: authHeaders(true),
        body: {
          request_id: requestId,
          seller_id: sellerId,
          subagent_id: subagentId
        }
      });

      if (response.status !== 201) {
        throw createUpstreamError("BUYER_PLATFORM_TOKEN_FAILED", response);
      }

      return response.body;
    },

    async getDeliveryMeta({ requestId, sellerId, subagentId, taskToken }) {
      const response = await requestJson(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
        method: "POST",
        headers: authHeaders(true),
        body: {
          seller_id: sellerId,
          subagent_id: subagentId,
          task_token: taskToken
        }
      });

      if (response.status !== 200) {
        throw createUpstreamError("BUYER_PLATFORM_DELIVERY_META_FAILED", response);
      }

      return response.body;
    },

    async getRequestEvents(requestId) {
      const response = await requestJson(baseUrl, `/v1/requests/${requestId}/events`, {
        headers: authHeaders(true)
      });

      if (response.status !== 200) {
        throw createUpstreamError("BUYER_PLATFORM_EVENTS_FAILED", response);
      }

      return response.body;
    },

    async postMetricEvent(body) {
      const response = await requestJson(baseUrl, "/v1/metrics/events", {
        method: "POST",
        headers: authHeaders(true),
        body
      });

      if (response.status !== 202) {
        throw createUpstreamError("BUYER_PLATFORM_METRIC_FAILED", response);
      }

      return response.body;
    }
  };
}

export function evaluateTimeouts(request, config) {
  if (TERMINAL_STATUS_SET.has(request.status)) {
    return null;
  }

  const now = Date.now();
  const ackDeadlineAt = request.ack_deadline_at ? new Date(request.ack_deadline_at).getTime() : null;
  const softTimeoutAt = new Date(request.soft_timeout_at).getTime();
  const hardTimeoutAt = new Date(request.hard_timeout_at).getTime();

  if (
    request.status === "SENT" &&
    ackDeadlineAt &&
    now >= ackDeadlineAt &&
    !request.acknowledged_at &&
    request.timeout_decision !== "continue_wait"
  ) {
    request.status = "TIMED_OUT";
    request.timed_out_at = nowIso();
    request.last_error_code = "DELIVERY_OR_ACCEPTANCE_TIMEOUT";
    request.needs_timeout_confirmation = false;
    return {
      status: request.status,
      eventType: "buyer.request.timed_out",
      code: request.last_error_code
    };
  }

  if (
    config.timeout_confirmation_mode === "ask_by_default" &&
    now >= softTimeoutAt &&
    request.timeout_decision === "pending"
  ) {
    request.needs_timeout_confirmation = true;
  }

  if (
    config.hard_timeout_auto_finalize &&
    ACTIVE_STATUS_SET.has(request.status) &&
    now >= hardTimeoutAt &&
    request.timeout_decision !== "continue_wait"
  ) {
    request.status = "TIMED_OUT";
    request.timed_out_at = nowIso();
    request.last_error_code = "EXEC_TIMEOUT_HARD";
    request.needs_timeout_confirmation = false;
    return {
      status: request.status,
      eventType: "buyer.request.timed_out",
      code: request.last_error_code
    };
  }

  return null;
}

export function createRequestRecord(config, body) {
  const requestId = body.request_id || `req_${crypto.randomUUID()}`;
  const ackDeadlineS = Number(body.ack_deadline_s || config.ack_deadline_s || 120);
  const softTimeoutS = Number(body.soft_timeout_s || 90);
  const hardTimeoutS = Number(body.hard_timeout_s || 300);
  const createdAtMs = Date.now();

  return {
    request_id: requestId,
    buyer_id: body.buyer_id || "buyer_default",
    seller_id: body.seller_id || null,
    subagent_id: body.subagent_id || null,
    contract_version: body.contract_version || "0.1.0",
    expected_signer_public_key_pem: body.expected_signer_public_key_pem || null,
    status: "CREATED",
    attempt: Number(body.attempt || 1),
    timeout_decision: "pending",
    needs_timeout_confirmation: false,
    timeline: [{ at: nowIso(), event: "CREATED" }],
    created_at: new Date(createdAtMs).toISOString(),
    updated_at: new Date(createdAtMs).toISOString(),
    ack_deadline_s: ackDeadlineS,
    ack_deadline_at: body.ack_deadline_at || null,
    soft_timeout_s: softTimeoutS,
    hard_timeout_s: hardTimeoutS,
    soft_timeout_at: new Date(createdAtMs + softTimeoutS * 1000).toISOString(),
    hard_timeout_at: new Date(createdAtMs + hardTimeoutS * 1000).toISOString(),
    config_snapshot: {
      ack_deadline_s: ackDeadlineS,
      timeout_confirmation_mode: config.timeout_confirmation_mode,
      hard_timeout_auto_finalize: config.hard_timeout_auto_finalize
    },
    task_token: body.task_token || null,
    delivery_meta: body.delivery_meta || null,
    platform_events: [],
    result_package: null,
    contract_draft: body.contract_draft || null,
    last_error_code: null,
    metric_flags: {}
  };
}

function markUpdated(request, event) {
  request.updated_at = nowIso();
  request.timeline.push({ at: request.updated_at, event });
}

function setSentState(request) {
  request.status = "SENT";
  request.last_error_code = null;
  if (!request.sent_at) {
    request.sent_at = nowIso();
  }
  request.ack_deadline_at = new Date(Date.now() + request.ack_deadline_s * 1000).toISOString();
  markUpdated(request, "SENT");
}

function resultContextMatchesRequest(request, body) {
  if (body.request_id !== request.request_id) {
    return false;
  }

  if (typeof body.result_version === "string" && body.result_version !== "0.1.0") {
    return false;
  }

  if (request.seller_id && body.seller_id !== request.seller_id) {
    return false;
  }

  if (request.subagent_id && body.subagent_id !== request.subagent_id) {
    return false;
  }

  return true;
}

function verifyResultSignature(request, body) {
  if (!body.signature_base64) {
    return body.signature_valid !== false;
  }

  if (!request.expected_signer_public_key_pem) {
    return false;
  }

  try {
    const bytes = Buffer.from(JSON.stringify(canonicalizeResultPackageForSignature(body)), "utf8");
    const signature = Buffer.from(body.signature_base64, "base64");
    const publicKey = crypto.createPublicKey(request.expected_signer_public_key_pem);
    return crypto.verify(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
}

export function applyResultPackage(request, body) {
  request.result_package = body;

  if (!resultContextMatchesRequest(request, body)) {
    request.status = "UNVERIFIED";
    request.last_error_code = "RESULT_CONTEXT_MISMATCH";
    markUpdated(request, "RESULT_CONTEXT_MISMATCH");
    return {
      status: request.status,
      eventType: "buyer.request.unverified",
      code: request.last_error_code
    };
  }

  if (!verifyResultSignature(request, body)) {
    request.status = "UNVERIFIED";
    request.last_error_code = "RESULT_SIGNATURE_INVALID";
    markUpdated(request, "RESULT_SIGNATURE_INVALID");
    return {
      status: request.status,
      eventType: "buyer.request.unverified",
      code: request.last_error_code
    };
  }

  if (body.schema_valid === false) {
    request.status = "UNVERIFIED";
    request.last_error_code = "RESULT_SCHEMA_INVALID";
    markUpdated(request, "RESULT_SCHEMA_INVALID");
    return {
      status: request.status,
      eventType: "buyer.request.unverified",
      code: request.last_error_code
    };
  }

  if (body.status === "ok") {
    request.status = "SUCCEEDED";
    request.last_error_code = null;
    markUpdated(request, "SUCCEEDED");
    return {
      status: request.status,
      eventType: "buyer.request.succeeded"
    };
  }

  request.status = "FAILED";
  request.last_error_code = body.error?.code || "EXEC_UNKNOWN";
  markUpdated(request, "FAILED");
  return {
    status: request.status,
    eventType: "buyer.request.failed",
    code: request.last_error_code
  };
}

async function reportBuyerMetric(platformClient, request, eventType, detail = {}) {
  if (!platformClient || !eventType) {
    return;
  }

  const metricKey = `${eventType}:${detail.code || ""}`;
  request.metric_flags ||= {};
  if (request.metric_flags[metricKey]) {
    return;
  }

  request.metric_flags[metricKey] = true;
  await platformClient.postMetricEvent({
    source: "buyer-controller",
    event_type: eventType,
    request_id: request.request_id,
    seller_id: request.seller_id,
    subagent_id: request.subagent_id,
    ...detail
  });
}

async function evaluateTimeoutsWithMetrics(request, config, platformClient) {
  const transition = evaluateTimeouts(request, config);
  if (transition?.eventType) {
    await reportBuyerMetric(platformClient, request, transition.eventType, { code: transition.code });
  }
  return transition;
}

async function persistBuyerState(onStateChanged, state) {
  if (typeof onStateChanged === "function") {
    await onStateChanged(state);
  }
}

export async function prepareBuyerRequest(request, platformClient, options = {}) {
  const sellerId = options.seller_id || options.sellerId || request.seller_id;
  const subagentId = options.subagent_id || options.subagentId || request.subagent_id;
  if (!sellerId || !subagentId) {
    throw new Error("buyer_prepare_requires_seller_and_subagent");
  }

  const issued = await platformClient.issueTaskToken({
    requestId: request.request_id,
    sellerId,
    subagentId
  });
  const deliveryMeta = await platformClient.getDeliveryMeta({
    requestId: request.request_id,
    sellerId,
    subagentId,
    taskToken: issued.task_token
  });

  if (
    request.expected_signer_public_key_pem &&
    deliveryMeta.seller_public_key_pem &&
    request.expected_signer_public_key_pem !== deliveryMeta.seller_public_key_pem
  ) {
    throw new Error("buyer_signer_binding_mismatch");
  }

  request.seller_id = sellerId;
  request.subagent_id = subagentId;
  request.task_token = issued.task_token;
  request.delivery_meta = deliveryMeta;
  request.expected_signer_public_key_pem =
    request.expected_signer_public_key_pem || deliveryMeta.seller_public_key_pem || null;
  request.last_error_code = null;
  markUpdated(request, "PREPARED");

  return {
    task_token: issued.task_token,
    claims: issued.claims,
    delivery_meta: deliveryMeta,
    request
  };
}

export function buildDispatchEnvelope(request, body = {}) {
  const deliveryAddress = request.delivery_meta?.delivery_address || body.delivery_address || request.seller_id;
  const threadHint = request.delivery_meta?.thread_hint || `req:${request.request_id}`;

  return {
    message_id: body.message_id || `msg_${crypto.randomUUID()}`,
    thread_id: body.thread_id || threadHint,
    from: body.from || "buyer-controller",
    to: body.to || deliveryAddress,
    type: body.type || "task.requested",
    request_id: request.request_id,
    seller_id: request.seller_id,
    subagent_id: request.subagent_id,
    task_token: body.task_token || request.task_token || null,
    payload: body.payload || {},
    simulate: body.simulate || "success",
    delay_ms: Number(body.delay_ms || 80),
    lease_ttl_s: Number(body.lease_ttl_s || 30),
    priority: Number(body.priority || 5),
    sent_at: nowIso()
  };
}

export function createTaskContractDraft(request, body = {}) {
  const taskInput = body.task_input ?? body.input ?? request.task_input ?? {};
  const outputSchema = body.output_schema ?? request.output_schema ?? null;
  const taskType = body.task_type || request.task_type || null;
  const returnRouteHint = body.return_route_hint || request.return_route_hint || null;
  const threadHint = body.thread_hint || request.delivery_meta?.thread_hint || `req:${request.request_id}`;
  const sourceRunId = body.source_run_id || request.source_run_id || null;
  const createdAt = body.created_at || nowIso();
  const constraints = {
    soft_timeout_s: body.soft_timeout_s ?? request.soft_timeout_s ?? null,
    hard_timeout_s: body.hard_timeout_s ?? request.hard_timeout_s ?? null
  };

  const contract = {
    request_id: request.request_id,
    contract_version: body.contract_version || request.contract_version || "0.1.0",
    created_at: createdAt,
    buyer: {
      buyer_id: body.buyer_id || request.buyer_id || "buyer_default"
    },
    seller: {
      seller_id: body.seller_id || request.seller_id,
      subagent_id: body.subagent_id || request.subagent_id
    },
    task: {
      task_type: taskType,
      input: taskInput,
      output_schema: outputSchema
    },
    constraints,
    token: body.task_token || request.task_token || null,
    trace: {
      thread_hint: threadHint
    }
  };

  if (returnRouteHint) {
    contract.buyer.return_route_hint = returnRouteHint;
  }
  if (sourceRunId) {
    contract.trace.source_run_id = sourceRunId;
  }

  request.task_type = taskType;
  request.task_input = taskInput;
  request.output_schema = outputSchema;
  request.return_route_hint = returnRouteHint;
  request.source_run_id = sourceRunId;
  request.contract_draft = contract;
  markUpdated(request, "CONTRACT_DRAFTED");

  return contract;
}

export async function syncBuyerRequestEvents(request, platformClient) {
  const response = await platformClient.getRequestEvents(request.request_id);
  const events = response.events || response.items || [];
  request.platform_events = events;

  const ackEvent = events.find((event) => event.event_type === "ACKED");
  if (ackEvent && !TERMINAL_STATUS_SET.has(request.status) && request.status !== "ACKED") {
    request.status = "ACKED";
    request.last_error_code = null;
    request.acknowledged_at = ackEvent.at || null;
    request.ack_eta_hint_s = Number.isFinite(Number(ackEvent.eta_hint_s)) ? Number(ackEvent.eta_hint_s) : null;
    markUpdated(request, "ACKED");
  }

  return {
    request_id: request.request_id,
    events,
    acked: Boolean(ackEvent),
    request
  };
}

export function createBuyerControllerServer({
  state = createBuyerState(),
  serviceName = "buyer-controller",
  config = loadBuyerConfig(),
  transport = null,
  platform = null,
  onStateChanged = null
} = {}) {
  const defaultPlatformClient = platform?.baseUrl ? createBuyerPlatformClient(platform) : null;

  function resolvePlatformClient(req) {
    if (!platform?.baseUrl) {
      return null;
    }

    const headerApiKey = req.headers["x-platform-api-key"];
    if (typeof headerApiKey === "string" && headerApiKey.trim()) {
      return createBuyerPlatformClient({
        baseUrl: platform.baseUrl,
        apiKey: headerApiKey.trim()
      });
    }

    return defaultPlatformClient;
  }

  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "Content-Type, Authorization, X-Platform-Api-Key"
        });
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: serviceName });
        return;
      }

      if (method === "GET" && pathname === "/readyz") {
        sendJson(res, 200, { ready: true, service: serviceName });
        return;
      }

      if (method === "GET" && pathname === "/") {
        const platformClient = resolvePlatformClient(req);
        sendJson(res, 200, {
          service: serviceName,
          status: "running",
          config,
          platform: platformClient ? { configured: true, base_url: platform.baseUrl } : { configured: false }
        });
        return;
      }

      if (method === "GET" && pathname === "/controller/catalog/subagents") {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendJson(res, 409, { error: "PLATFORM_NOT_CONFIGURED" });
          return;
        }

        try {
          const catalog = await platformClient.listCatalogSubagents({
            status: url.searchParams.get("status") || undefined,
            availability_status: url.searchParams.get("availability_status") || undefined,
            seller_id: url.searchParams.get("seller_id") || undefined,
            subagent_id: url.searchParams.get("subagent_id") || undefined
          });
          sendJson(res, 200, catalog);
        } catch (error) {
          sendUpstreamError(res, error, "BUYER_PLATFORM_CATALOG_FAILED");
        }
        return;
      }

      if (method === "POST" && pathname === "/controller/requests") {
        const body = await parseJsonBody(req);
        const record = createRequestRecord(config, body);
        state.requests.set(record.request_id, record);
        await persistBuyerState(onStateChanged, state);
        sendJson(res, 201, record);
        return;
      }

      if (method === "GET" && pathname === "/controller/requests") {
        const items = Array.from(state.requests.values());
        const platformClient = resolvePlatformClient(req);
        let mutated = false;
        for (const item of items) {
          const transition = await evaluateTimeoutsWithMetrics(item, config, platformClient);
          mutated ||= Boolean(transition);
        }
        if (mutated) {
          await persistBuyerState(onStateChanged, state);
        }
        sendJson(res, 200, { items });
        return;
      }

      const requestMatch = pathname.match(/^\/controller\/requests\/([^/]+)$/);
      if (method === "GET" && requestMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(requestMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }
        const transition = await evaluateTimeoutsWithMetrics(request, config, platformClient);
        if (transition) {
          await persistBuyerState(onStateChanged, state);
        }
        sendJson(res, 200, request);
        return;
      }

      const prepareMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/prepare$/);
      if (method === "POST" && prepareMatch) {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendJson(res, 409, { error: "PLATFORM_NOT_CONFIGURED" });
          return;
        }

        const request = state.requests.get(prepareMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        try {
          const body = await parseJsonBody(req);
          const prepared = await prepareBuyerRequest(request, platformClient, body);
          await persistBuyerState(onStateChanged, state);
          sendJson(res, 200, prepared);
        } catch (error) {
          if (error instanceof Error && error.message === "buyer_prepare_requires_seller_and_subagent") {
            sendJson(res, 400, { error: "CONTRACT_INVALID_PREPARE_REQUEST" });
            return;
          }
          if (error instanceof Error && error.message === "buyer_signer_binding_mismatch") {
            sendJson(res, 409, { error: "SIGNER_BINDING_MISMATCH" });
            return;
          }
          sendUpstreamError(res, error, "BUYER_PLATFORM_PREPARE_FAILED");
        }
        return;
      }

      const contractMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/contract-draft$/);
      if (method === "POST" && contractMatch) {
        const request = state.requests.get(contractMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        const body = await parseJsonBody(req);
        const contract = createTaskContractDraft(request, body);
        await persistBuyerState(onStateChanged, state);
        sendJson(res, 200, { request_id: request.request_id, contract });
        return;
      }

      const markSentMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/mark-sent$/);
      if (method === "POST" && markSentMatch) {
        const request = state.requests.get(markSentMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        if (!TERMINAL_STATUS_SET.has(request.status)) {
          setSentState(request);
          await persistBuyerState(onStateChanged, state);
        }

        sendJson(res, 200, request);
        return;
      }

      const dispatchMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/dispatch$/);
      if (method === "POST" && dispatchMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(dispatchMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        if (!transport) {
          sendJson(res, 409, { error: "TRANSPORT_NOT_CONFIGURED" });
          return;
        }

        const body = await parseJsonBody(req);
        const envelope = buildDispatchEnvelope(request, body);

        await transport.send(envelope);

        if (!TERMINAL_STATUS_SET.has(request.status)) {
          setSentState(request);
        }
        await reportBuyerMetric(platformClient, request, "buyer.request.dispatched");
        await persistBuyerState(onStateChanged, state);

        sendJson(res, 202, { accepted: true, envelope, request });
        return;
      }

      const syncEventsMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/sync-events$/);
      if (method === "POST" && syncEventsMatch) {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendJson(res, 409, { error: "PLATFORM_NOT_CONFIGURED" });
          return;
        }

        const request = state.requests.get(syncEventsMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        try {
          const synced = await syncBuyerRequestEvents(request, platformClient);
          if (synced.acked) {
            await reportBuyerMetric(platformClient, request, "buyer.request.acked");
          }
          await persistBuyerState(onStateChanged, state);
          sendJson(res, 200, synced);
        } catch (error) {
          sendUpstreamError(res, error, "BUYER_PLATFORM_EVENTS_FAILED");
        }
        return;
      }

      const ackMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(ackMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        if (!TERMINAL_STATUS_SET.has(request.status)) {
          request.status = "ACKED";
          request.acknowledged_at = nowIso();
          request.last_error_code = null;
          markUpdated(request, "ACKED");
        }
        await reportBuyerMetric(platformClient, request, "buyer.request.acked");
        await persistBuyerState(onStateChanged, state);

        sendJson(res, 200, request);
        return;
      }

      const resultMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/result$/);
      if (method === "POST" && resultMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(resultMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        if (TERMINAL_STATUS_SET.has(request.status)) {
          sendJson(res, 409, { error: "REQUEST_ALREADY_TERMINAL", status: request.status });
          return;
        }

        const body = await parseJsonBody(req);
        const transition = applyResultPackage(request, body);
        if (transition?.eventType) {
          await reportBuyerMetric(platformClient, request, transition.eventType, { code: transition.code });
        }
        await persistBuyerState(onStateChanged, state);
        sendJson(res, 200, request);
        return;
      }

      if (method === "POST" && pathname === "/controller/inbox/pull") {
        const platformClient = resolvePlatformClient(req);
        if (!transport) {
          sendJson(res, 409, { error: "TRANSPORT_NOT_CONFIGURED" });
          return;
        }

        const body = await parseJsonBody(req);
        const polled = await transport.poll({
          limit: Number(body.limit || 10),
          receiver: body.receiver || "buyer-controller"
        });
        const accepted = [];
        let mutated = false;

        for (const envelope of polled.items) {
          const resultPackage = envelope.result_package || envelope.payload?.result_package || envelope.payload;
          if (!resultPackage?.request_id) {
            continue;
          }

          const request = state.requests.get(resultPackage.request_id);
          if (!request) {
            continue;
          }

          if (!TERMINAL_STATUS_SET.has(request.status)) {
            const transition = applyResultPackage(request, resultPackage);
            if (transition?.eventType) {
              await reportBuyerMetric(platformClient, request, transition.eventType, { code: transition.code });
            }
            mutated = true;
          }

          await transport.ack(envelope.message_id, {
            receiver: body.receiver || "buyer-controller"
          });
          accepted.push({ message_id: envelope.message_id, request_id: resultPackage.request_id });
        }

        if (mutated) {
          await persistBuyerState(onStateChanged, state);
        }
        sendJson(res, 200, { accepted });
        return;
      }

      const timeoutMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/timeout-decision$/);
      if (method === "POST" && timeoutMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(timeoutMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        const body = await parseJsonBody(req);
        const continueWait = body.continue_wait === true;

        request.timeout_decision = continueWait ? "continue_wait" : "stop_wait";
        request.needs_timeout_confirmation = false;
        if (!continueWait && !TERMINAL_STATUS_SET.has(request.status)) {
          request.status = "TIMED_OUT";
          request.last_error_code = "EXEC_TIMEOUT_MANUAL_STOP";
          request.timed_out_at = nowIso();
        }
        markUpdated(request, continueWait ? "TIMEOUT_DECISION_CONTINUE" : "TIMEOUT_DECISION_STOP");
        if (!continueWait) {
          await reportBuyerMetric(platformClient, request, "buyer.request.timed_out", {
            code: request.last_error_code
          });
        }
        await persistBuyerState(onStateChanged, state);

        sendJson(res, 200, request);
        return;
      }

      sendJson(res, 404, { error: "not_found", path: pathname });
    } catch (error) {
      if (error.message === "invalid_json") {
        sendJson(res, 400, { error: "CONTRACT_INVALID_JSON" });
        return;
      }

      sendJson(res, 500, {
        error: "BUYER_CONTROLLER_INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "unknown_error"
      });
    }
  });
}
