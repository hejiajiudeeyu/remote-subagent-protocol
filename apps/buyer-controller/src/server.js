import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "UNVERIFIED", "TIMED_OUT", "DISPUTED"]);
const ACTIVE_STATUSES = new Set(["CREATED", "SENT", "ACKED", "RUNNING"]);

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
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function loadConfig() {
  return {
    timeout_confirmation_mode: process.env.TIMEOUT_CONFIRMATION_MODE || "ask_by_default",
    hard_timeout_auto_finalize: String(process.env.HARD_TIMEOUT_AUTO_FINALIZE || "true") === "true",
    poll_interval_active_s: Number(process.env.BUYER_CONTROLLER_POLL_INTERVAL_ACTIVE_S || 5),
    poll_interval_backoff_s: Number(process.env.BUYER_CONTROLLER_POLL_INTERVAL_BACKOFF_S || 15)
  };
}

export function createBuyerState() {
  return { requests: new Map() };
}

function evaluateTimeouts(request, config) {
  if (TERMINAL_STATUSES.has(request.status)) {
    return;
  }

  const now = Date.now();
  const softTimeoutAt = new Date(request.soft_timeout_at).getTime();
  const hardTimeoutAt = new Date(request.hard_timeout_at).getTime();

  if (
    config.timeout_confirmation_mode === "ask_by_default" &&
    now >= softTimeoutAt &&
    request.timeout_decision === "pending"
  ) {
    request.needs_timeout_confirmation = true;
  }

  if (
    config.hard_timeout_auto_finalize &&
    ACTIVE_STATUSES.has(request.status) &&
    now >= hardTimeoutAt &&
    request.timeout_decision !== "continue_wait"
  ) {
    request.status = "TIMED_OUT";
    request.timed_out_at = nowIso();
    request.last_error_code = "EXEC_TIMEOUT_HARD";
    request.needs_timeout_confirmation = false;
  }
}

function createRequestRecord(config, body) {
  const requestId = body.request_id || `req_${crypto.randomUUID()}`;
  const softTimeoutS = Number(body.soft_timeout_s || 90);
  const hardTimeoutS = Number(body.hard_timeout_s || 300);
  const createdAtMs = Date.now();

  return {
    request_id: requestId,
    buyer_id: body.buyer_id || "buyer_default",
    seller_id: body.seller_id || null,
    subagent_id: body.subagent_id || null,
    expected_signer_public_key_pem: body.expected_signer_public_key_pem || null,
    status: "CREATED",
    attempt: Number(body.attempt || 1),
    timeout_decision: "pending",
    needs_timeout_confirmation: false,
    timeline: [{ at: nowIso(), event: "CREATED" }],
    created_at: new Date(createdAtMs).toISOString(),
    updated_at: new Date(createdAtMs).toISOString(),
    soft_timeout_at: new Date(createdAtMs + softTimeoutS * 1000).toISOString(),
    hard_timeout_at: new Date(createdAtMs + hardTimeoutS * 1000).toISOString(),
    config_snapshot: {
      timeout_confirmation_mode: config.timeout_confirmation_mode,
      hard_timeout_auto_finalize: config.hard_timeout_auto_finalize
    },
    result_package: null,
    last_error_code: null
  };
}

function markUpdated(request, event) {
  request.updated_at = nowIso();
  request.timeline.push({ at: request.updated_at, event });
}

function verifyResultSignature(request, body) {
  if (!body.signature_base64) {
    return body.signature_valid !== false;
  }

  if (!request.expected_signer_public_key_pem) {
    return false;
  }

  try {
    const verifierPayload = {};
    if ("request_id" in body) verifierPayload.request_id = body.request_id;
    if ("status" in body) verifierPayload.status = body.status;
    if ("output" in body) verifierPayload.output = body.output;
    if ("error" in body) verifierPayload.error = body.error;
    if ("schema_valid" in body) verifierPayload.schema_valid = body.schema_valid;
    if ("timing" in body) verifierPayload.timing = body.timing;
    if ("usage" in body) verifierPayload.usage = body.usage;
    const bytes = Buffer.from(JSON.stringify(verifierPayload), "utf8");
    const signature = Buffer.from(body.signature_base64, "base64");
    const publicKey = crypto.createPublicKey(request.expected_signer_public_key_pem);
    return crypto.verify(null, bytes, publicKey, signature);
  } catch {
    return false;
  }
}

function applyResultPackage(request, body) {
  request.result_package = body;

  if (!verifyResultSignature(request, body)) {
    request.status = "UNVERIFIED";
    request.last_error_code = "RESULT_SIGNATURE_INVALID";
    markUpdated(request, "RESULT_SIGNATURE_INVALID");
    return;
  }

  if (body.schema_valid === false) {
    request.status = "UNVERIFIED";
    request.last_error_code = "RESULT_SCHEMA_INVALID";
    markUpdated(request, "RESULT_SCHEMA_INVALID");
    return;
  }

  if (body.status === "ok") {
    request.status = "SUCCEEDED";
    request.last_error_code = null;
    markUpdated(request, "SUCCEEDED");
    return;
  }

  request.status = "FAILED";
  request.last_error_code = body.error?.code || "EXEC_UNKNOWN";
  markUpdated(request, "FAILED");
}

export function createBuyerControllerServer({
  state = createBuyerState(),
  serviceName = "buyer-controller",
  config = loadConfig(),
  transport = null
} = {}) {
  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    try {
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: serviceName });
        return;
      }

      if (method === "GET" && pathname === "/readyz") {
        sendJson(res, 200, { ready: true, service: serviceName });
        return;
      }

      if (method === "GET" && pathname === "/") {
        sendJson(res, 200, { service: serviceName, status: "running", config });
        return;
      }

      if (method === "POST" && pathname === "/controller/requests") {
        const body = await parseJsonBody(req);
        const record = createRequestRecord(config, body);
        state.requests.set(record.request_id, record);
        sendJson(res, 201, record);
        return;
      }

      if (method === "GET" && pathname === "/controller/requests") {
        const items = Array.from(state.requests.values());
        for (const item of items) {
          evaluateTimeouts(item, config);
        }
        sendJson(res, 200, { items });
        return;
      }

      const requestMatch = pathname.match(/^\/controller\/requests\/([^/]+)$/);
      if (method === "GET" && requestMatch) {
        const request = state.requests.get(requestMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }
        evaluateTimeouts(request, config);
        sendJson(res, 200, request);
        return;
      }

      const markSentMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/mark-sent$/);
      if (method === "POST" && markSentMatch) {
        const request = state.requests.get(markSentMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        if (!TERMINAL_STATUSES.has(request.status)) {
          request.status = "SENT";
          markUpdated(request, "SENT");
        }

        sendJson(res, 200, request);
        return;
      }

      const dispatchMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/dispatch$/);
      if (method === "POST" && dispatchMatch) {
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
        const envelope = {
          message_id: body.message_id || `msg_${crypto.randomUUID()}`,
          thread_id: body.thread_id || `req:${request.request_id}`,
          from: body.from || "buyer-controller",
          to: body.to || request.seller_id,
          type: body.type || "task.requested",
          request_id: request.request_id,
          seller_id: request.seller_id,
          subagent_id: request.subagent_id,
          task_token: body.task_token || null,
          payload: body.payload || {},
          simulate: body.simulate || "success",
          delay_ms: Number(body.delay_ms || 80),
          lease_ttl_s: Number(body.lease_ttl_s || 30),
          priority: Number(body.priority || 5),
          sent_at: nowIso()
        };

        await transport.send(envelope);

        if (!TERMINAL_STATUSES.has(request.status)) {
          request.status = "SENT";
          request.last_error_code = null;
          markUpdated(request, "SENT");
        }

        sendJson(res, 202, { accepted: true, envelope, request });
        return;
      }

      const ackMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const request = state.requests.get(ackMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        if (!TERMINAL_STATUSES.has(request.status)) {
          request.status = "ACKED";
          markUpdated(request, "ACKED");
        }

        sendJson(res, 200, request);
        return;
      }

      const resultMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/result$/);
      if (method === "POST" && resultMatch) {
        const request = state.requests.get(resultMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        if (TERMINAL_STATUSES.has(request.status)) {
          sendJson(res, 409, { error: "REQUEST_ALREADY_TERMINAL", status: request.status });
          return;
        }

        const body = await parseJsonBody(req);
        applyResultPackage(request, body);
        sendJson(res, 200, request);
        return;
      }

      if (method === "POST" && pathname === "/controller/inbox/pull") {
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

        for (const envelope of polled.items) {
          const resultPackage = envelope.result_package || envelope.payload?.result_package || envelope.payload;
          if (!resultPackage?.request_id) {
            continue;
          }

          const request = state.requests.get(resultPackage.request_id);
          if (!request) {
            continue;
          }

          if (!TERMINAL_STATUSES.has(request.status)) {
            applyResultPackage(request, resultPackage);
          }

          await transport.ack(envelope.message_id, {
            receiver: body.receiver || "buyer-controller"
          });
          accepted.push({ message_id: envelope.message_id, request_id: resultPackage.request_id });
        }

        sendJson(res, 200, { accepted });
        return;
      }

      const timeoutMatch = pathname.match(/^\/controller\/requests\/([^/]+)\/timeout-decision$/);
      if (method === "POST" && timeoutMatch) {
        const request = state.requests.get(timeoutMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }

        const body = await parseJsonBody(req);
        const continueWait = body.continue_wait === true;

        request.timeout_decision = continueWait ? "continue_wait" : "stop_wait";
        request.needs_timeout_confirmation = false;
        if (!continueWait && !TERMINAL_STATUSES.has(request.status)) {
          request.status = "TIMED_OUT";
          request.last_error_code = "EXEC_TIMEOUT_MANUAL_STOP";
          request.timed_out_at = nowIso();
        }
        markUpdated(request, continueWait ? "TIMEOUT_DECISION_CONTINUE" : "TIMEOUT_DECISION_STOP");

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

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === __filename;
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 8081);
  const serviceName = process.env.SERVICE_NAME || "buyer-controller";
  const server = createBuyerControllerServer({ serviceName });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port}`);
  });
}
