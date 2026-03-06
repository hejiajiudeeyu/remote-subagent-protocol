import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

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

async function postJson(baseUrl, pathname, { method = "POST", headers = {}, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

function buildResultPayload(task) {
  if (task.simulate === "token_expired") {
    return {
      request_id: task.request_id,
      status: "error",
      error: {
        code: "AUTH_TOKEN_EXPIRED",
        message: "Token expired during seller validation"
      },
      schema_valid: true,
      timing: { exec_ms: task.delay_ms },
      usage: { tokens_in: 0, tokens_out: 0 }
    };
  }

  if (task.simulate === "schema_invalid") {
    return {
      request_id: task.request_id,
      status: "ok",
      output: { malformed_field: true },
      schema_valid: false,
      timing: { exec_ms: task.delay_ms },
      usage: { tokens_in: 12, tokens_out: 6 }
    };
  }

  if (task.simulate === "reject") {
    return {
      request_id: task.request_id,
      status: "error",
      error: {
        code: "CONTRACT_REJECTED",
        message: "Seller guardrail rejected this task"
      },
      schema_valid: true,
      timing: { exec_ms: task.delay_ms },
      usage: { tokens_in: 0, tokens_out: 0 }
    };
  }

  return {
    request_id: task.request_id,
    status: "ok",
    output: {
      summary: "Task completed",
      task_id: task.task_id
    },
    schema_valid: true,
    timing: { exec_ms: task.delay_ms },
    usage: { tokens_in: 42, tokens_out: 24 }
  };
}

function signResultPayload(payload, state) {
  const signingBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = crypto.sign(null, signingBytes, state.signing.privateKey);
  return {
    ...payload,
    signature_algorithm: "Ed25519",
    signer_public_key_pem: state.signing.publicKeyPem,
    signature_base64: signature.toString("base64")
  };
}

async function sendResultEnvelope(task, state, transport) {
  if (!transport || !task.reply_to || !task.result_package) {
    return;
  }

  await transport.send({
    message_id: `msg_result_${crypto.randomUUID()}`,
    thread_id: task.thread_id || `req:${task.request_id}`,
    from: state.identity.seller_id,
    to: task.reply_to,
    type: "task.result",
    request_id: task.request_id,
    seller_id: state.identity.seller_id,
    subagent_id: task.subagent_id,
    result_package: task.result_package,
    sent_at: nowIso()
  });
}

async function ackPlatform(task, platform) {
  if (!platform?.baseUrl || !platform.apiKey) {
    return { ok: false, skipped: true };
  }

  const response = await postJson(platform.baseUrl, `/v1/requests/${task.request_id}/ack`, {
    headers: {
      Authorization: `Bearer ${platform.apiKey}`
    },
    body: {
      seller_id: platform.sellerId || task.seller_id,
      subagent_id: task.subagent_id,
      eta_hint_s: Math.max(1, Math.ceil(task.delay_ms / 1000))
    }
  });

  return { ok: response.status >= 200 && response.status < 300, response };
}

async function introspectTaskToken(task, platform) {
  if (!platform?.baseUrl || !platform.apiKey || !task.task_token) {
    return { active: true, skipped: true };
  }

  const response = await postJson(platform.baseUrl, "/v1/tokens/introspect", {
    headers: {
      Authorization: `Bearer ${platform.apiKey}`
    },
    body: {
      task_token: task.task_token
    }
  });

  return response.body || { active: false, error: "AUTH_INTROSPECT_FAILED" };
}

export function createSellerState(options = {}) {
  const signing = options.signing
    ? {
        privateKey: crypto.createPrivateKey(options.signing.privateKeyPem),
        publicKeyPem: options.signing.publicKeyPem
      }
    : (() => {
        const generated = crypto.generateKeyPairSync("ed25519");
        return {
          privateKey: generated.privateKey,
          publicKeyPem: generated.publicKey.export({ type: "spki", format: "pem" }).toString()
        };
      })();

  return {
    tasks: new Map(),
    queue: [],
    processing: false,
    signing,
    identity: {
      seller_id: options.sellerId || "seller_foxlab",
      subagent_ids: options.subagentIds || ["foxlab.text.classifier.v1"]
    }
  };
}

function scheduleProcessQueue(state, { transport = null } = {}) {
  if (state.processing) {
    return;
  }

  const nextTaskId = state.queue.shift();
  if (!nextTaskId) {
    return;
  }

  const task = state.tasks.get(nextTaskId);
  if (!task) {
    scheduleProcessQueue(state, { transport });
    return;
  }

  task.status = "RUNNING";
  task.started_at = nowIso();
  task.lease_expires_at = new Date(Date.now() + task.lease_ttl_s * 1000).toISOString();
  state.processing = true;

  setTimeout(() => {
    if (task.simulate === "timeout") {
      task.status = "RUNNING";
      task.updated_at = nowIso();
      state.processing = false;
      scheduleProcessQueue(state, { transport });
      return;
    }

    task.status = "COMPLETED";
    task.completed_at = nowIso();
    task.updated_at = task.completed_at;
    const payload = buildResultPayload(task);
    task.result_package = signResultPayload(payload, state);
    void sendResultEnvelope(task, state, transport);
    state.processing = false;
    scheduleProcessQueue(state, { transport });
  }, task.delay_ms);
}

function enqueueTask(state, task, { transport = null } = {}) {
  state.tasks.set(task.task_id, task);
  state.queue.push(task.task_id);

  state.queue.sort((leftId, rightId) => {
    const left = state.tasks.get(leftId);
    const right = state.tasks.get(rightId);
    if (!left || !right) {
      return 0;
    }
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.enqueued_at.localeCompare(right.enqueued_at);
  });

  scheduleProcessQueue(state, { transport });
}

export function createSellerControllerServer({
  state = createSellerState(),
  serviceName = "seller-controller",
  transport = null,
  platform = null
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
        sendJson(res, 200, { service: serviceName, status: "running" });
        return;
      }

      if (method === "GET" && pathname === "/controller/public-key") {
        sendJson(res, 200, {
          seller_id: state.identity.seller_id,
          public_key_pem: state.signing.publicKeyPem
        });
        return;
      }

      if (method === "POST" && pathname === "/controller/tasks") {
        const body = await parseJsonBody(req);
        const task = {
          task_id: body.task_id || `task_${crypto.randomUUID()}`,
          request_id: body.request_id || `req_${crypto.randomUUID()}`,
          subagent_id: body.subagent_id || "unknown_subagent",
          simulate: body.simulate || "success",
          priority: Number(body.priority || 5),
          delay_ms: Number(body.delay_ms || 80),
          lease_ttl_s: Number(body.lease_ttl_s || 30),
          status: "QUEUED",
          acked: true,
          enqueued_at: nowIso(),
          updated_at: nowIso(),
          result_package: null,
          reply_to: body.reply_to || null,
          thread_id: body.thread_id || `req:${body.request_id || crypto.randomUUID()}`,
          task_token: body.task_token || null,
          seller_id: body.seller_id || state.identity.seller_id
        };

        enqueueTask(state, task, { transport });

        sendJson(res, 202, {
          accepted: true,
          task_id: task.task_id,
          request_id: task.request_id,
          status: task.status,
          queue_policy: {
            mode: "priority_fifo",
            tenant_quota: "mvp_default",
            lease_ttl_s: task.lease_ttl_s
          }
        });
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
          receiver: body.receiver || state.identity.seller_id
        });
        const accepted = [];

        for (const envelope of polled.items) {
          if (envelope.seller_id && envelope.seller_id !== state.identity.seller_id) {
            continue;
          }
          if (envelope.subagent_id && !state.identity.subagent_ids.includes(envelope.subagent_id)) {
            continue;
          }

          const task = {
            task_id: envelope.task_id || `task_${crypto.randomUUID()}`,
            request_id: envelope.request_id || `req_${crypto.randomUUID()}`,
            subagent_id: envelope.subagent_id || state.identity.subagent_ids[0],
            simulate: envelope.simulate || "success",
            priority: Number(envelope.priority || 5),
            delay_ms: Number(envelope.delay_ms || 80),
            lease_ttl_s: Number(envelope.lease_ttl_s || 30),
            status: "QUEUED",
            acked: true,
            enqueued_at: nowIso(),
            updated_at: nowIso(),
            result_package: null,
            reply_to: envelope.from || "buyer-controller",
            thread_id: envelope.thread_id || `req:${envelope.request_id}`,
            task_token: envelope.task_token || null,
            seller_id: envelope.seller_id || state.identity.seller_id
          };

          const introspection = await introspectTaskToken(task, platform);
          if (introspection.active === false) {
            task.status = "COMPLETED";
            task.completed_at = nowIso();
            task.updated_at = task.completed_at;
            task.result_package = signResultPayload(
              {
                request_id: task.request_id,
                status: "error",
                error: {
                  code: introspection.error || "AUTH_TOKEN_INVALID",
                  message: "Task token rejected during seller validation"
                },
                schema_valid: true,
                timing: { exec_ms: 0 },
                usage: { tokens_in: 0, tokens_out: 0 }
              },
              state
            );
            state.tasks.set(task.task_id, task);
            await sendResultEnvelope(task, state, transport);
          } else {
            enqueueTask(state, task, { transport });
            const acked = await ackPlatform(task, platform);
            task.acked = acked.ok;
          }

          await transport.ack(envelope.message_id);
          accepted.push({ message_id: envelope.message_id, task_id: task.task_id });
        }

        sendJson(res, 200, { accepted });
        return;
      }

      if (method === "GET" && pathname === "/controller/queue") {
        const queued = state.queue.map((taskId) => state.tasks.get(taskId)).filter(Boolean);
        const running = Array.from(state.tasks.values()).filter((task) => task.status === "RUNNING");
        sendJson(res, 200, { queued, running });
        return;
      }

      const taskMatch = pathname.match(/^\/controller\/tasks\/([^/]+)$/);
      if (method === "GET" && taskMatch) {
        const task = state.tasks.get(taskMatch[1]);
        if (!task) {
          sendJson(res, 404, { error: "TASK_NOT_FOUND" });
          return;
        }

        sendJson(res, 200, task);
        return;
      }

      const resultMatch = pathname.match(/^\/controller\/tasks\/([^/]+)\/result$/);
      if (method === "GET" && resultMatch) {
        const task = state.tasks.get(resultMatch[1]);
        if (!task) {
          sendJson(res, 404, { error: "TASK_NOT_FOUND" });
          return;
        }

        if (!task.result_package) {
          sendJson(res, 202, { available: false, status: task.status });
          return;
        }

        sendJson(res, 200, { available: true, status: task.status, result_package: task.result_package });
        return;
      }

      const replayMatch = pathname.match(/^\/controller\/tasks\/([^/]+)\/replay$/);
      if (method === "POST" && replayMatch) {
        const task = state.tasks.get(replayMatch[1]);
        if (!task) {
          sendJson(res, 404, { error: "TASK_NOT_FOUND" });
          return;
        }

        if (!task.result_package) {
          sendJson(res, 409, { error: "RESULT_NOT_READY", status: task.status });
          return;
        }

        sendJson(res, 200, { replayed: true, result_package: task.result_package });
        return;
      }

      sendJson(res, 404, { error: "not_found", path: pathname });
    } catch (error) {
      if (error.message === "invalid_json") {
        sendJson(res, 400, { error: "CONTRACT_INVALID_JSON" });
        return;
      }

      sendJson(res, 500, {
        error: "SELLER_CONTROLLER_INTERNAL_ERROR",
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
  const port = Number(process.env.PORT || 8082);
  const serviceName = process.env.SERVICE_NAME || "seller-controller";
  const server = createSellerControllerServer({ serviceName });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port}`);
  });
}
