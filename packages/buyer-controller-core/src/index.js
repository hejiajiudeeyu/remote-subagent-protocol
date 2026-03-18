import crypto from "node:crypto";
import http from "node:http";

import { buildStructuredError, canonicalizeResultPackageForSignature } from "@delexec/contracts";

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

function sendError(res, statusCode, code, message, { retryable, ...extra } = {}) {
  sendJson(res, statusCode, buildStructuredError(code, message, { retryable, ...extra }));
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

function sendUpstreamError(res, error, fallbackCode, fallbackMessage = "upstream service error") {
  if (error?.response) {
    sendJson(res, error.response.status, error.response.body || { error: { code: fallbackCode, message: fallbackMessage, retryable: true } });
    return;
  }

  sendError(res, 502, fallbackCode, error instanceof Error ? error.message : fallbackMessage, { retryable: true });
}

export function loadBuyerConfig() {
  return {
    ack_deadline_s: Number(process.env.ACK_DEADLINE_S || 120),
    timeout_confirmation_mode: process.env.TIMEOUT_CONFIRMATION_MODE || "ask_by_default",
    hard_timeout_auto_finalize: String(process.env.HARD_TIMEOUT_AUTO_FINALIZE || "true") === "true",
    poll_interval_active_s: Number(process.env.BUYER_CONTROLLER_POLL_INTERVAL_ACTIVE_S || 5),
    poll_interval_backoff_s: Number(process.env.BUYER_CONTROLLER_POLL_INTERVAL_BACKOFF_S || 15),
    events_sync_batch_size: Number(process.env.BUYER_CONTROLLER_EVENTS_SYNC_BATCH_SIZE || 25)
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
    config: {
      baseUrl,
      apiKey: apiKey || null
    },

    async registerBuyer({ contactEmail, contact_email, email } = {}) {
      const response = await requestJson(baseUrl, "/v1/users/register", {
        method: "POST",
        body: {
          ...(contactEmail || contact_email ? { contact_email: contactEmail || contact_email } : {}),
          ...(email ? { email } : {})
        }
      });

      if (response.status !== 201) {
        throw createUpstreamError("BUYER_PLATFORM_REGISTER_FAILED", response);
      }

      return response.body;
    },

    async listCatalogSubagents(filters = {}) {
      const params = new URLSearchParams();
      if (filters.status) {
        params.set("status", filters.status);
      }
      if (filters.availability_status) {
        params.set("availability_status", filters.availability_status);
      }
      if (filters.task_type) {
        params.set("task_type", filters.task_type);
      }
      if (filters.capability) {
        params.set("capability", filters.capability);
      }
      if (filters.tag) {
        params.set("tag", filters.tag);
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

    async registerSeller(body = {}) {
      const response = await requestJson(baseUrl, "/v1/sellers/register", {
        method: "POST",
        headers: authHeaders(true),
        body
      });

      if (response.status !== 201) {
        throw createUpstreamError("BUYER_PLATFORM_SELLER_REGISTER_FAILED", response);
      }

      return response.body;
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

    async getDeliveryMeta({ requestId, sellerId, subagentId, taskToken, resultDelivery }) {
      const response = await requestJson(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
        method: "POST",
        headers: authHeaders(true),
        body: {
          seller_id: sellerId,
          subagent_id: subagentId,
          task_token: taskToken,
          result_delivery: resultDelivery
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

    async getRequestEventsBatch(requestIds = []) {
      const response = await requestJson(baseUrl, "/v1/requests/events/batch", {
        method: "POST",
        headers: authHeaders(true),
        body: {
          request_ids: Array.isArray(requestIds) ? requestIds : []
        }
      });

      if (response.status !== 200) {
        throw createUpstreamError("BUYER_PLATFORM_EVENTS_BATCH_FAILED", response);
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
    result_delivery: body.result_delivery || { kind: "local", address: "buyer-controller" },
    verification: body.verification || null,
    delivery_meta: body.delivery_meta || null,
    platform_events: [],
    platform_completed_at: null,
    platform_failed_at: null,
    platform_last_event: null,
    result_package: null,
    contract_draft: body.contract_draft || null,
    last_error_code: null,
    metric_flags: {}
  };
}

function getTaskDelivery(request, body = {}) {
  return request.delivery_meta?.task_delivery || body.task_delivery || null;
}

function getResultDelivery(request, body = {}) {
  return request.delivery_meta?.result_delivery || body.result_delivery || request.result_delivery || null;
}

function extractEmailResult(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { resultPackage: null, attachments: [], parseError: false };
  }

  if (envelope.result_package || envelope.payload?.result_package) {
    return {
      resultPackage: envelope.result_package || envelope.payload?.result_package,
      attachments: envelope.attachments || envelope.payload?.attachments || [],
      parseError: false
    };
  }

  if (typeof envelope.body_text === "string" && envelope.body_text.trim()) {
    try {
      return {
        resultPackage: JSON.parse(envelope.body_text),
        attachments: envelope.attachments || [],
        parseError: false
      };
    } catch {
      return { resultPackage: null, attachments: envelope.attachments || [], parseError: true };
    }
  }

  return {
    resultPackage: envelope.payload?.request_id ? envelope.payload : null,
    attachments: envelope.attachments || [],
    parseError: false
  };
}

function verifyArtifactBindings(body, attachments = []) {
  const declared = Array.isArray(body.artifacts) ? body.artifacts : [];
  if (declared.length === 0) {
    return attachments.length === 0;
  }

  for (const artifact of declared) {
    const attachment = attachments.find((item) => item.name === artifact.name);
    if (!attachment) {
      return false;
    }
    if (artifact.media_type && attachment.media_type !== artifact.media_type) {
      return false;
    }
    if (Number.isFinite(Number(artifact.byte_size)) && Number(artifact.byte_size) !== Number(attachment.byte_size)) {
      return false;
    }
    if (artifact.sha256) {
      const digest = crypto.createHash("sha256").update(Buffer.from(attachment.content_base64 || "", "base64")).digest("hex");
      if (digest !== artifact.sha256) {
        return false;
      }
    }
  }

  return true;
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

  if (request.verification?.display_code && body.verification?.display_code !== request.verification.display_code) {
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

export function applyResultPackage(request, body, { attachments = [] } = {}) {
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

  if (!verifyArtifactBindings(body, attachments)) {
    request.status = "UNVERIFIED";
    request.last_error_code = "RESULT_ARTIFACT_INVALID";
    markUpdated(request, "RESULT_ARTIFACT_INVALID");
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

function isBuyerRequestActive(request) {
  return ACTIVE_STATUS_SET.has(request.status);
}

async function pollBuyerInbox(
  state,
  transport,
  platformClientResolver,
  onStateChanged,
  receiver = "buyer-controller"
) {
  if (!transport) {
    return { accepted: [], mutated: false };
  }

  const polled = await transport.poll({
    limit: 10,
    receiver
  });
  const accepted = [];
  let mutated = false;

  for (const envelope of polled.items) {
    const { resultPackage, attachments, parseError } = extractEmailResult(envelope);
    if (!resultPackage?.request_id && parseError && envelope.request_id) {
      const request = state.requests.get(envelope.request_id);
      if (request && !TERMINAL_STATUS_SET.has(request.status)) {
        request.status = "UNVERIFIED";
        request.last_error_code = "RESULT_BODY_INVALID_JSON";
        markUpdated(request, "RESULT_BODY_INVALID_JSON");
        mutated = true;
      }
      await transport.ack(envelope.message_id, { receiver });
      accepted.push({ message_id: envelope.message_id, request_id: envelope.request_id });
      continue;
    }
    if (!resultPackage?.request_id) {
      continue;
    }

    const request = state.requests.get(resultPackage.request_id);
    if (!request) {
      continue;
    }
    const platformClient = typeof platformClientResolver === "function" ? platformClientResolver(request) : null;

    if (!TERMINAL_STATUS_SET.has(request.status)) {
      const transition = applyResultPackage(request, resultPackage, { attachments });
      if (transition?.eventType) {
        await reportBuyerMetric(platformClient, request, transition.eventType, { code: transition.code });
      }
      mutated = true;
    }

    await transport.ack(envelope.message_id, { receiver });
    accepted.push({ message_id: envelope.message_id, request_id: resultPackage.request_id });
  }

  if (mutated) {
    await persistBuyerState(onStateChanged, state);
  }

  return { accepted, mutated };
}

async function syncBuyerActiveRequests(state, config, platformClientFactory, onStateChanged) {
  let mutated = false;
  const activeGroups = new Map();
  const requestClients = new Map();

  for (const request of state.requests.values()) {
    const platformClient = typeof platformClientFactory === "function" ? platformClientFactory(request) : null;
    requestClients.set(request.request_id, platformClient);

    if (!platformClient || !isBuyerRequestActive(request)) {
      continue;
    }

    const clientKey = `${platformClient.config?.baseUrl || "unknown"}::${platformClient.config?.apiKey || "anonymous"}`;
    const existingGroup = activeGroups.get(clientKey) || {
      client: platformClient,
      requests: []
    };
    existingGroup.requests.push(request);
    activeGroups.set(clientKey, existingGroup);
  }

  const batchSize = Math.max(1, Number(config.events_sync_batch_size || 25));

  for (const group of activeGroups.values()) {
    const { client: platformClient, requests } = group;
    for (let index = 0; index < requests.length; index += batchSize) {
      const batch = requests.slice(index, index + batchSize);
      const requestIds = batch.map((request) => request.request_id);
      try {
        const response = await platformClient.getRequestEventsBatch(requestIds);
        const byRequestId = new Map((response.items || []).map((item) => [item.request_id, item]));
        for (const request of batch) {
          const item = byRequestId.get(request.request_id);
          if (!item || item.found === false) {
            continue;
          }
          const synced = applyPlatformEventsToRequest(request, item.events || item.items || []);
          if (synced.acked) {
            await reportBuyerMetric(platformClient, request, "buyer.request.acked");
          }
          mutated = true;
        }
      } catch {
        for (const request of batch) {
          try {
            const synced = await syncBuyerRequestEvents(request, platformClient);
            if (synced.acked) {
              await reportBuyerMetric(platformClient, request, "buyer.request.acked");
            }
            mutated = true;
          } catch {
            // ignore background sync failures; foreground APIs still expose explicit sync
          }
        }
      }
    }
  }

  for (const request of state.requests.values()) {
    const transition = await evaluateTimeoutsWithMetrics(
      request,
      config,
      requestClients.get(request.request_id) || null
    );
    mutated ||= Boolean(transition);
  }

  if (mutated) {
    await persistBuyerState(onStateChanged, state);
  }

  return { mutated };
}

export function startBuyerBackgroundLoops({
  state,
  config = loadBuyerConfig(),
  transport = null,
  receiver = "buyer-controller",
  inboxPollIntervalMs = 1000,
  eventsSyncIntervalMs = 1000,
      platformClientFactory = () => null,
  onStateChanged = null,
  logger = console
} = {}) {
  let stopped = false;
  let inboxRunning = false;
  let syncRunning = false;

  async function runInboxPoll() {
    if (stopped || inboxRunning || !transport) {
      return;
    }
    inboxRunning = true;
    try {
      await pollBuyerInbox(state, transport, platformClientFactory, onStateChanged, receiver);
    } catch (error) {
      logger?.warn?.(`[buyer-background] inbox poll failed: ${error instanceof Error ? error.message : "unknown_error"}`);
    } finally {
      inboxRunning = false;
    }
  }

  async function runEventSync() {
    if (stopped || syncRunning) {
      return;
    }
    syncRunning = true;
    try {
      await syncBuyerActiveRequests(state, config, platformClientFactory, onStateChanged);
    } catch (error) {
      logger?.warn?.(`[buyer-background] request sync failed: ${error instanceof Error ? error.message : "unknown_error"}`);
    } finally {
      syncRunning = false;
    }
  }

  void runInboxPoll();
  void runEventSync();

  const inboxTimer = transport
    ? setInterval(() => {
        void runInboxPoll();
      }, inboxPollIntervalMs)
    : null;
  const syncTimer = setInterval(() => {
    void runEventSync();
  }, eventsSyncIntervalMs);

  return () => {
    stopped = true;
    if (inboxTimer) {
      clearInterval(inboxTimer);
    }
    clearInterval(syncTimer);
  };
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
    taskToken: issued.task_token,
    resultDelivery: options.result_delivery || options.resultDelivery || request.result_delivery
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
  request.result_delivery = deliveryMeta.result_delivery || request.result_delivery || null;
  request.verification = deliveryMeta.verification || request.verification || null;
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
  const taskDelivery = getTaskDelivery(request, body);
  const resultDelivery = getResultDelivery(request, body);
  const deliveryAddress = taskDelivery?.address || body.task_delivery_address || request.seller_id;
  const threadHint = taskDelivery?.thread_hint || request.delivery_meta?.thread_hint || `req:${request.request_id}`;

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
    result_delivery: resultDelivery,
    verification: request.verification || request.delivery_meta?.verification || null,
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
  const resultDelivery = body.result_delivery || getResultDelivery(request, body);
  const threadHint = body.thread_hint || getTaskDelivery(request, body)?.thread_hint || `req:${request.request_id}`;
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

  if (resultDelivery) {
    contract.buyer.result_delivery = resultDelivery;
  }
  if (request.verification || body.verification) {
    contract.verification = body.verification || request.verification;
  }
  if (sourceRunId) {
    contract.trace.source_run_id = sourceRunId;
  }

  request.task_type = taskType;
  request.task_input = taskInput;
  request.output_schema = outputSchema;
  request.result_delivery = resultDelivery;
  request.source_run_id = sourceRunId;
  request.contract_draft = contract;
  markUpdated(request, "CONTRACT_DRAFTED");

  return contract;
}

export async function syncBuyerRequestEvents(request, platformClient) {
  const response = await platformClient.getRequestEvents(request.request_id);
  return applyPlatformEventsToRequest(request, response.events || response.items || []);
}

export function applyPlatformEventsToRequest(request, events = []) {
  request.platform_events = events;
  request.platform_last_event = events.length > 0 ? events[events.length - 1] : null;

  const ackEvent = events.find((event) => event.event_type === "ACKED");
  const completedEvent = events.find((event) => event.event_type === "COMPLETED");
  const failedEvent = events.find((event) => event.event_type === "FAILED");
  request.platform_completed_at = completedEvent?.finished_at || completedEvent?.at || null;
  request.platform_failed_at = failedEvent?.finished_at || failedEvent?.at || null;
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
  background = {},
  onStateChanged = null
} = {}) {
  const defaultPlatformClient = platform?.baseUrl ? createBuyerPlatformClient(platform) : null;
  const defaultBackgroundPlatformClient = platform?.baseUrl && platform?.apiKey ? createBuyerPlatformClient(platform) : null;
  const requestPlatformAuth = new Map();

  function resolvePlatformConfig(req) {
    if (!platform?.baseUrl) {
      return null;
    }

    const headerApiKey = req?.headers?.["x-platform-api-key"];
    if (typeof headerApiKey === "string" && headerApiKey.trim()) {
      return {
        baseUrl: platform.baseUrl,
        apiKey: headerApiKey.trim()
      };
    }

    return platform;
  }

  function resolvePlatformClient(req) {
    const resolved = resolvePlatformConfig(req);
    if (!resolved?.baseUrl) {
      return null;
    }
    if (resolved === platform && defaultPlatformClient) {
      return defaultPlatformClient;
    }
    return createBuyerPlatformClient(resolved);
  }
  const server = http.createServer(async (req, res) => {
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
          platform: platformClient ? { configured: true, base_url: platform.baseUrl } : { configured: false },
          local_defaults: {
            buyer_contact_email: process.env.BUYER_CONTACT_EMAIL || null,
            platform_api_key_configured: Boolean(platform?.apiKey)
          }
        });
        return;
      }

      if (method === "GET" && pathname === "/controller/catalog/subagents") {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendError(res, 409, "PLATFORM_NOT_CONFIGURED", "platform client is not configured");
          return;
        }

        try {
          const catalog = await platformClient.listCatalogSubagents({
            status: url.searchParams.get("status") || undefined,
            availability_status: url.searchParams.get("availability_status") || undefined,
            task_type: url.searchParams.get("task_type") || undefined,
            capability: url.searchParams.get("capability") || undefined,
            tag: url.searchParams.get("tag") || undefined,
            seller_id: url.searchParams.get("seller_id") || undefined,
            subagent_id: url.searchParams.get("subagent_id") || undefined
          });
          sendJson(res, 200, catalog);
        } catch (error) {
          sendUpstreamError(res, error, "BUYER_PLATFORM_CATALOG_FAILED", "catalog query failed");
        }
        return;
      }

      if (method === "POST" && pathname === "/controller/register") {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendError(res, 409, "PLATFORM_NOT_CONFIGURED", "platform client is not configured");
          return;
        }

        try {
          const body = await parseJsonBody(req);
          const registered = await platformClient.registerBuyer(body);
          sendJson(res, 201, registered);
        } catch (error) {
          sendUpstreamError(res, error, "BUYER_PLATFORM_REGISTER_FAILED", "platform registration failed");
        }
        return;
      }

      if (method === "POST" && pathname === "/controller/seller/register") {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendError(res, 409, "PLATFORM_NOT_CONFIGURED", "platform client is not configured");
          return;
        }

        try {
          const body = await parseJsonBody(req);
          const registered = await platformClient.registerSeller(body);
          sendJson(res, 201, registered);
        } catch (error) {
          sendUpstreamError(res, error, "BUYER_PLATFORM_SELLER_REGISTER_FAILED", "seller registration failed");
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
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        const transition = await evaluateTimeoutsWithMetrics(request, config, platformClient);
        if (transition) {
          await persistBuyerState(onStateChanged, state);
        }
        sendJson(res, 200, request);
        return;
      }

      const requestResultMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/result$/);
      if (method === "GET" && requestResultMatch) {
        const request = state.requests.get(requestResultMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (!TERMINAL_STATUS_SET.has(request.status) || !request.result_package) {
          sendJson(res, 200, { available: false, status: request.status, result_package: null });
          return;
        }
        sendJson(res, 200, {
          available: true,
          status: request.status,
          result_package: request.result_package
        });
        return;
      }

      const prepareMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/prepare$/);
      if (method === "POST" && prepareMatch) {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendError(res, 409, "PLATFORM_NOT_CONFIGURED", "platform client is not configured");
          return;
        }

        const request = state.requests.get(prepareMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }

        try {
          const body = await parseJsonBody(req);
          const platformConfig = resolvePlatformConfig(req);
          if (platformConfig?.apiKey) {
            requestPlatformAuth.set(request.request_id, platformConfig);
          }
          const prepared = await prepareBuyerRequest(request, platformClient, body);
          await persistBuyerState(onStateChanged, state);
          sendJson(res, 200, prepared);
        } catch (error) {
          if (error instanceof Error && error.message === "buyer_prepare_requires_seller_and_subagent") {
            sendError(res, 400, "CONTRACT_INVALID_PREPARE_REQUEST", "seller_id and subagent_id are required");
            return;
          }
          if (error instanceof Error && error.message === "buyer_signer_binding_mismatch") {
            sendError(res, 409, "SIGNER_BINDING_MISMATCH", "expected signer public key does not match catalog");
            return;
          }
          sendUpstreamError(res, error, "BUYER_PLATFORM_PREPARE_FAILED", "request preparation failed");
        }
        return;
      }

      if (method === "POST" && pathname === "/controller/remote-requests") {
        const platformClient = resolvePlatformClient(req);
        if (!platformClient) {
          sendError(res, 409, "PLATFORM_NOT_CONFIGURED", "platform client is not configured");
          return;
        }
        if (!transport) {
          sendError(res, 409, "TRANSPORT_NOT_CONFIGURED", "transport adapter is not configured");
          return;
        }

        try {
          const body = await parseJsonBody(req);
          const request = createRequestRecord(config, body);
          state.requests.set(request.request_id, request);

          const platformConfig = resolvePlatformConfig(req);
          if (platformConfig?.apiKey) {
            requestPlatformAuth.set(request.request_id, platformConfig);
          }

          const prepared = await prepareBuyerRequest(request, platformClient, body);
          const contract = createTaskContractDraft(request, body);
          const envelope = buildDispatchEnvelope(request, {
            ...body,
            task_token: prepared.task_token
          });

          await transport.send(envelope);
          if (!TERMINAL_STATUS_SET.has(request.status)) {
            setSentState(request);
          }
          await reportBuyerMetric(platformClient, request, "buyer.request.dispatched");
          await persistBuyerState(onStateChanged, state);

          sendJson(res, 201, {
            request_id: request.request_id,
            request,
            task_token: prepared.task_token,
            delivery_meta: prepared.delivery_meta,
            contract,
            envelope
          });
        } catch (error) {
          if (error instanceof Error && error.message === "buyer_prepare_requires_seller_and_subagent") {
            sendError(res, 400, "CONTRACT_INVALID_REMOTE_REQUEST", "seller_id and subagent_id are required");
            return;
          }
          if (error instanceof Error && error.message === "buyer_signer_binding_mismatch") {
            sendError(res, 409, "SIGNER_BINDING_MISMATCH", "expected signer public key does not match catalog");
            return;
          }
          sendUpstreamError(res, error, "BUYER_REMOTE_REQUEST_FAILED", "remote request dispatch failed");
        }
        return;
      }

      const contractMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/contract-draft$/);
      if (method === "POST" && contractMatch) {
        const request = state.requests.get(contractMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
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
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
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
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }

        if (!transport) {
          sendError(res, 409, "TRANSPORT_NOT_CONFIGURED", "transport adapter is not configured");
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
          sendError(res, 409, "PLATFORM_NOT_CONFIGURED", "platform client is not configured");
          return;
        }

        const request = state.requests.get(syncEventsMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
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
          sendUpstreamError(res, error, "BUYER_PLATFORM_EVENTS_FAILED", "event sync failed");
        }
        return;
      }

      const ackMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(ackMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
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

      if (method === "POST" && requestResultMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(requestResultMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }

        if (TERMINAL_STATUS_SET.has(request.status)) {
          sendError(res, 409, "REQUEST_ALREADY_TERMINAL", "request has already reached a terminal state", { status: request.status });
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
        if (!transport) {
          sendError(res, 409, "TRANSPORT_NOT_CONFIGURED", "transport adapter is not configured");
          return;
        }

        const body = await parseJsonBody(req);
        const platformConfig = resolvePlatformConfig(req);
        const result = await pollBuyerInbox(
          state,
          transport,
          () => (platformConfig?.apiKey ? createBuyerPlatformClient(platformConfig) : null),
          onStateChanged,
          body.receiver || "buyer-controller"
        );
        sendJson(res, 200, { accepted: result.accepted });
        return;
      }

      const timeoutMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/timeout-decision$/);
      if (method === "POST" && timeoutMatch) {
        const platformClient = resolvePlatformClient(req);
        const request = state.requests.get(timeoutMatch[1]);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
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

      sendError(res, 404, "not_found", "no matching route", { path: pathname });
    } catch (error) {
      if (error.message === "invalid_json") {
        sendError(res, 400, "CONTRACT_INVALID_JSON", "request body is not valid JSON");
        return;
      }

      sendError(res, 500, "BUYER_CONTROLLER_INTERNAL_ERROR", error instanceof Error ? error.message : "unknown_error", { retryable: true });
    }
  });

  const backgroundEnabled = background.enabled === true;
  let stopBackground = () => {};
  if (backgroundEnabled) {
    stopBackground = startBuyerBackgroundLoops({
      state,
      config,
      transport,
      receiver: background.receiver || "buyer-controller",
      inboxPollIntervalMs: Number(background.inboxPollIntervalMs || 250),
      eventsSyncIntervalMs: Number(background.eventsSyncIntervalMs || 250),
      platformClientFactory: (request) => {
        const auth = requestPlatformAuth.get(request.request_id);
        if (auth?.baseUrl && auth?.apiKey) {
          return createBuyerPlatformClient(auth);
        }
        if (defaultBackgroundPlatformClient) {
          return defaultBackgroundPlatformClient;
        }
        return null;
      },
      onStateChanged
    });
    server.on("close", () => {
      stopBackground();
    });
  }

  return server;
}
