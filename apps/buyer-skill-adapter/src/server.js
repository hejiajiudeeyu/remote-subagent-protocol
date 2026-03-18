import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function structuredError(code, message, extra = {}) {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false,
      ...extra
    }
  };
}

function normalizedString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed || null;
}

function buildBuyerHeaders() {
  const headers = {};
  if (process.env.BUYER_PLATFORM_API_KEY || process.env.PLATFORM_API_KEY) {
    headers["X-Platform-Api-Key"] = process.env.BUYER_PLATFORM_API_KEY || process.env.PLATFORM_API_KEY;
  }
  return headers;
}

async function parseJsonBody(req) {
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

async function requestJson(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...buildBuyerHeaders(),
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

function buyerBaseUrl() {
  return process.env.BUYER_CONTROLLER_BASE_URL || `http://127.0.0.1:${process.env.BUYER_CONTROLLER_PORT || 8081}`;
}

function mapCatalogItem(item) {
  return {
    subagentId: item.subagent_id,
    sellerId: item.seller_id,
    displayName: item.display_name || item.subagent_id,
    taskTypes: item.task_types || [],
    capabilities: item.capabilities || [],
    tags: item.tags || [],
    status: item.availability_status || item.status || "enabled"
  };
}

function mapRequestState(request, result = null) {
  const resultPackage = result?.result_package || request?.result_package || null;
  return {
    requestId: request?.request_id || null,
    status: request?.status || "UNKNOWN",
    subagentId: request?.subagent_id || resultPackage?.subagent_id || null,
    seller: {
      sellerId: request?.seller_id || resultPackage?.seller_id || null,
      subagentId: request?.subagent_id || resultPackage?.subagent_id || null
    },
    result: resultPackage?.output || null,
    error: resultPackage?.error || null,
    resultPackage
  };
}

async function waitForTerminalRequest(requestId, { timeoutMs, intervalMs } = {}) {
  const startedAt = Date.now();
  const maxWaitMs = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : Number(process.env.SKILL_MAX_WAIT_MS || 30000);
  const pollEveryMs = Number.isFinite(Number(intervalMs)) ? Number(intervalMs) : Number(process.env.SKILL_POLL_INTERVAL_MS || 250);
  while (Date.now() - startedAt < maxWaitMs) {
    const request = await requestJson(buyerBaseUrl(), `/controller/requests/${encodeURIComponent(requestId)}`);
    if (request.status !== 200) {
      return request;
    }
    const result = await requestJson(buyerBaseUrl(), `/controller/requests/${encodeURIComponent(requestId)}/result`);
    if (["SUCCEEDED", "FAILED", "UNVERIFIED", "TIMED_OUT"].includes(request.body?.status) || result.body?.available === true) {
      return {
        status: 200,
        body: mapRequestState(request.body, result.body)
      };
    }
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
  }
  return {
    status: 200,
    body: {
      requestId,
      status: "PENDING",
      result: null,
      error: {
        code: "SKILL_WAIT_TIMEOUT",
        message: "request did not reach terminal state before skill timeout",
        retryable: true
      }
    }
  };
}

async function resolveCatalogTarget(subagentId, sellerId = null) {
  const params = new URLSearchParams();
  if (subagentId) {
    params.set("subagent_id", subagentId);
  }
  if (sellerId) {
    params.set("seller_id", sellerId);
  }
  const catalog = await requestJson(buyerBaseUrl(), `/controller/catalog/subagents?${params.toString()}`);
  if (catalog.status !== 200) {
    return catalog;
  }
  const selected = (catalog.body?.items || []).find((item) => {
    if (item.subagent_id !== subagentId) {
      return false;
    }
    if (sellerId && item.seller_id !== sellerId) {
      return false;
    }
    return true;
  });
  if (!selected) {
    return {
      status: 404,
      body: structuredError("SUBAGENT_NOT_FOUND", "no catalog subagent matched the requested subagentId", {
        subagentId,
        sellerId
      })
    };
  }
  return {
    status: 200,
    body: selected
  };
}

function buildInvokePayload(body, selected) {
  const softTimeoutS = Number(body?.constraints?.softTimeoutS);
  const hardTimeoutS = Number(body?.constraints?.hardTimeoutS);
  return {
    seller_id: selected.seller_id,
    subagent_id: selected.subagent_id,
    expected_signer_public_key_pem: selected.seller_public_key_pem || null,
    task_type: normalizedString(body.taskType) || selected.task_types?.[0] || null,
    input: body.input || {},
    payload: body.input || {},
    soft_timeout_s: Number.isFinite(softTimeoutS) ? softTimeoutS : undefined,
    hard_timeout_s: Number.isFinite(hardTimeoutS) ? hardTimeoutS : undefined
  };
}

export function createBuyerSkillAdapterServer() {
  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;
    try {
      if (method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }
      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, { ok: true, service: "buyer-skill-adapter" });
        return;
      }
      if (method === "GET" && pathname === "/skills/remote-subagent/catalog") {
        const catalog = await requestJson(buyerBaseUrl(), `/controller/catalog/subagents${url.search}`);
        sendJson(
          res,
          catalog.status,
          catalog.status === 200 ? { items: (catalog.body?.items || []).map(mapCatalogItem) } : catalog.body
        );
        return;
      }
      if (method === "POST" && pathname === "/skills/remote-subagent/invoke") {
        const body = await parseJsonBody(req);
        const subagentId = normalizedString(body.subagentId);
        if (!subagentId) {
          sendJson(res, 400, structuredError("SUBAGENT_ID_REQUIRED", "subagentId is required"));
          return;
        }
        const target = await resolveCatalogTarget(subagentId, normalizedString(body.sellerId));
        if (target.status !== 200) {
          sendJson(res, target.status, target.body);
          return;
        }
        const created = await requestJson(buyerBaseUrl(), "/controller/remote-requests", {
          method: "POST",
          body: buildInvokePayload(body, target.body)
        });
        if (created.status !== 201) {
          sendJson(res, created.status, created.body);
          return;
        }
        const terminal = await waitForTerminalRequest(created.body.request_id, {
          timeoutMs: Number(body?.constraints?.hardTimeoutS) ? Number(body.constraints.hardTimeoutS) * 1000 + 2000 : undefined
        });
        sendJson(res, terminal.status, terminal.body);
        return;
      }
      const requestMatch = pathname.match(/^\/skills\/remote-subagent\/requests\/([^/]+)$/);
      if (method === "GET" && requestMatch) {
        const requestId = decodeURIComponent(requestMatch[1]);
        const request = await requestJson(buyerBaseUrl(), `/controller/requests/${encodeURIComponent(requestId)}`);
        if (request.status !== 200) {
          sendJson(res, request.status, request.body);
          return;
        }
        const result = await requestJson(buyerBaseUrl(), `/controller/requests/${encodeURIComponent(requestId)}/result`);
        sendJson(res, 200, mapRequestState(request.body, result.body));
        return;
      }
      sendJson(res, 404, structuredError("NOT_FOUND", "unknown route"));
    } catch (error) {
      sendJson(res, 500, structuredError("SKILL_ADAPTER_RUNTIME_ERROR", error instanceof Error ? error.message : "unknown_error"));
    }
  });
}

const __filename = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const port = Number(process.env.PORT || 8091);
  const server = createBuyerSkillAdapterServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`[buyer-skill-adapter] listening on ${port}`);
  });
}
