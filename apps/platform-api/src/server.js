import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresSnapshotStore } from "../../../packages/postgres-store/src/index.js";
import { createSqliteSnapshotStore } from "../../../packages/sqlite-store/src/index.js";

const __filename = fileURLToPath(import.meta.url);

const HEARTBEAT_INTERVAL_S = 30;
const DEGRADED_THRESHOLD_S = 90;
const OFFLINE_THRESHOLD_S = 180;

function nowIso() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
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

function encodeBase64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64Url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signToken(secret, claims) {
  const payload = encodeBase64Url(JSON.stringify(claims));
  const mac = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

function parseToken(secret, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return { valid: false, error: "AUTH_TOKEN_INVALID" };
  }

  const [payload, signature] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature || "");

  if (expectedBytes.length !== signatureBytes.length || !crypto.timingSafeEqual(expectedBytes, signatureBytes)) {
    return { valid: false, error: "AUTH_TOKEN_INVALID" };
  }

  try {
    const claims = JSON.parse(decodeBase64Url(payload));
    if (typeof claims.exp !== "number" || Date.now() >= claims.exp * 1000) {
      return { valid: false, error: "AUTH_TOKEN_EXPIRED", claims };
    }
    return { valid: true, claims };
  } catch {
    return { valid: false, error: "AUTH_TOKEN_INVALID" };
  }
}

function decodePemEnv(value) {
  if (!value) {
    return null;
  }
  return value.replace(/\\n/g, "\n");
}

function createSellerIdentity({
  sellerId,
  subagentId,
  templateRef,
  displayName,
  deliveryAddress,
  apiKey = null,
  ownerUserId = null,
  signing = null
}) {
  const keyPair = signing
    ? {
        publicKeyPem: signing.publicKeyPem,
        privateKeyPem: signing.privateKeyPem
      }
    : (() => {
        const generated = crypto.generateKeyPairSync("ed25519");
        return {
          publicKeyPem: generated.publicKey.export({ type: "spki", format: "pem" }).toString(),
          privateKeyPem: generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
        };
      })();
  const sellerApiKey = apiKey || `sk_seller_${crypto.randomBytes(12).toString("hex")}`;
  const sellerUserId = ownerUserId || randomId("user");
  const lastHeartbeatAt = nowIso();

  return {
    seller: {
      seller_id: sellerId,
      owner_user_id: sellerUserId,
      api_key: sellerApiKey,
      scopes: ["seller"],
      subagent_ids: [subagentId],
      last_heartbeat_at: lastHeartbeatAt,
      availability_status: "healthy",
      contact_email: `${sellerId}@test.local`,
      support_email: `support+${sellerId}@test.local`
    },
    catalogItem: {
      seller_id: sellerId,
      subagent_id: subagentId,
      display_name: displayName,
      status: "active",
      availability_status: "healthy",
      last_heartbeat_at: lastHeartbeatAt,
      template_ref: templateRef,
      seller_public_key_pem: keyPair.publicKeyPem,
      delivery_address: deliveryAddress
    },
    signing: {
      publicKeyPem: keyPair.publicKeyPem,
      privateKeyPem: keyPair.privateKeyPem
    }
  };
}

function createTemplateBundle(templateRef) {
  return {
    template_ref: templateRef,
    input_schema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        context: { type: "object" }
      }
    },
    output_schema: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string" }
      }
    }
  };
}

function sanitizeCatalogItem(item) {
  const { delivery_address, ...publicItem } = item;
  return publicItem;
}

function buildAvailability(lastHeartbeatAt) {
  const ageSeconds = (Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000;
  if (ageSeconds > OFFLINE_THRESHOLD_S) {
    return "offline";
  }
  if (ageSeconds > DEGRADED_THRESHOLD_S) {
    return "degraded";
  }
  return "healthy";
}

function resolveCatalogAvailability(item) {
  if (item.availability_status && item.availability_status !== "healthy") {
    return item.availability_status;
  }
  return buildAvailability(item.last_heartbeat_at);
}

async function persistPlatformState(onStateChanged, state) {
  if (typeof onStateChanged === "function") {
    await onStateChanged(state);
  }
}

export function createPlatformState(options = {}) {
  const tokenSecret = options.tokenSecret || crypto.randomBytes(32);
  const tokenTtlSeconds = Number(options.tokenTtlSeconds || process.env.TOKEN_TTL_SECONDS || 300);
  const bootstrapSellerSigning =
    process.env.BOOTSTRAP_SELLER_PUBLIC_KEY_PEM && process.env.BOOTSTRAP_SELLER_PRIVATE_KEY_PEM
      ? {
          publicKeyPem: decodePemEnv(process.env.BOOTSTRAP_SELLER_PUBLIC_KEY_PEM),
          privateKeyPem: decodePemEnv(process.env.BOOTSTRAP_SELLER_PRIVATE_KEY_PEM)
        }
      : null;

  const bootstrapSellers = [
    createSellerIdentity({
      sellerId: process.env.BOOTSTRAP_SELLER_ID || "seller_foxlab",
      subagentId: process.env.BOOTSTRAP_SUBAGENT_ID || "foxlab.text.classifier.v1",
      templateRef: "foxlab/text-classifier@v1",
      displayName: "Foxlab Text Classifier",
      deliveryAddress:
        process.env.BOOTSTRAP_DELIVERY_ADDRESS || "local://relay/seller_foxlab/foxlab.text.classifier.v1",
      apiKey: process.env.BOOTSTRAP_SELLER_API_KEY || null,
      ownerUserId: process.env.BOOTSTRAP_SELLER_OWNER_USER_ID || null,
      signing: bootstrapSellerSigning
    }),
    createSellerIdentity({
      sellerId: "seller_northwind",
      subagentId: "northwind.copywriter.v1",
      templateRef: "northwind/copywriter@v1",
      displayName: "Northwind Copywriter",
      deliveryAddress: "local://relay/seller_northwind/northwind.copywriter.v1"
    })
  ];

  const users = new Map();
  const apiKeys = new Map();
  const sellers = new Map();
  const catalog = new Map();
  const templates = new Map();
  const requests = new Map();
  const metricsEvents = [];

  for (const item of bootstrapSellers) {
    sellers.set(item.seller.seller_id, item.seller);
    apiKeys.set(item.seller.api_key, {
      type: "seller",
      seller_id: item.seller.seller_id,
      owner_user_id: item.seller.owner_user_id,
      scopes: item.seller.scopes,
      subagent_ids: item.seller.subagent_ids
    });
    catalog.set(item.catalogItem.subagent_id, { ...item.catalogItem });
    templates.set(item.catalogItem.template_ref, createTemplateBundle(item.catalogItem.template_ref));
  }

  return {
    tokenSecret,
    tokenTtlSeconds,
    users,
    apiKeys,
    sellers,
    catalog,
    templates,
    requests,
    metricsEvents,
    bootstrap: {
      sellers: bootstrapSellers.map((item) => ({
        seller_id: item.seller.seller_id,
        subagent_id: item.catalogItem.subagent_id,
        api_key: item.seller.api_key,
        signing: item.signing
      }))
    }
  };
}

export function serializePlatformState(state) {
  return {
    users: Array.from(state.users.entries()),
    apiKeys: Array.from(state.apiKeys.entries()),
    sellers: Array.from(state.sellers.entries()),
    catalog: Array.from(state.catalog.entries()),
    templates: Array.from(state.templates.entries()),
    requests: Array.from(state.requests.entries()),
    metricsEvents: state.metricsEvents
  };
}

export function hydratePlatformState(state, snapshot) {
  if (!snapshot) {
    return state;
  }

  for (const [name, collection] of [
    ["users", state.users],
    ["apiKeys", state.apiKeys],
    ["sellers", state.sellers],
    ["catalog", state.catalog],
    ["templates", state.templates],
    ["requests", state.requests]
  ]) {
    collection.clear();
    for (const [key, value] of snapshot[name] || []) {
      collection.set(key, value);
    }
  }

  state.metricsEvents.splice(0, state.metricsEvents.length, ...(snapshot.metricsEvents || []));
  return state;
}

function resolveAuth(req, state) {
  const authorization = req.headers.authorization || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  return state.apiKeys.get(match[1]) || null;
}

function requireAuth(req, res, state) {
  const auth = resolveAuth(req, state);
  if (!auth) {
    sendJson(res, 401, { error: "AUTH_UNAUTHORIZED" });
    return null;
  }
  return auth;
}

function requireBuyer(req, res, state) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type !== "buyer") {
    sendJson(res, 403, { error: "AUTH_SCOPE_FORBIDDEN" });
    return null;
  }
  return auth;
}

function requireSeller(req, res, state, { sellerId, subagentId } = {}) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type !== "seller") {
    sendJson(res, 403, { error: "AUTH_SCOPE_FORBIDDEN" });
    return null;
  }
  if (sellerId && auth.seller_id !== sellerId) {
    sendJson(res, 403, { error: "AUTH_RESOURCE_FORBIDDEN" });
    return null;
  }
  if (subagentId && !auth.subagent_ids.includes(subagentId)) {
    sendJson(res, 403, { error: "AUTH_RESOURCE_FORBIDDEN" });
    return null;
  }
  return auth;
}

function getOrCreateRequest(state, requestId) {
  let request = state.requests.get(requestId);
  if (!request) {
    request = {
      request_id: requestId,
      buyer_id: null,
      seller_id: null,
      subagent_id: null,
      events: []
    };
    state.requests.set(requestId, request);
  }
  return request;
}

function appendRequestEvent(request, eventType, detail = {}) {
  request.events.push({
    at: nowIso(),
    event_type: eventType,
    ...detail
  });
}

function issueTaskToken(state, auth, body) {
  const catalogItem = state.catalog.get(body.subagent_id);
  if (!catalogItem || catalogItem.seller_id !== body.seller_id || catalogItem.status !== "active") {
    return { error: "CATALOG_SUBAGENT_NOT_FOUND" };
  }

  const request = getOrCreateRequest(state, body.request_id);
  if (request.buyer_id && request.buyer_id !== auth.user_id) {
    return { error: "AUTH_RESOURCE_FORBIDDEN", statusCode: 403 };
  }
  if (request.seller_id && request.seller_id !== body.seller_id) {
    return { error: "REQUEST_BINDING_MISMATCH", statusCode: 409 };
  }
  if (request.subagent_id && request.subagent_id !== body.subagent_id) {
    return { error: "REQUEST_BINDING_MISMATCH", statusCode: 409 };
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const tokenTtlSeconds = Number(process.env.TOKEN_TTL_SECONDS || state.tokenTtlSeconds);
  const claims = {
    iss: "croc-platform-api",
    sub: auth.user_id,
    aud: body.seller_id,
    jti: randomId("tok"),
    iat: issuedAt,
    exp: issuedAt + tokenTtlSeconds,
    buyer_id: auth.user_id,
    request_id: body.request_id,
    seller_id: body.seller_id,
    subagent_id: body.subagent_id
  };
  const token = signToken(state.tokenSecret, claims);
  request.buyer_id = auth.user_id;
  request.seller_id = body.seller_id;
  request.subagent_id = body.subagent_id;
  appendRequestEvent(request, "TASK_TOKEN_ISSUED", { actor_type: "buyer" });

  return { task_token: token, claims };
}

export function createPlatformServer({
  state = createPlatformState(),
  serviceName = "platform-api",
  onStateChanged = null
} = {}) {
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
        sendJson(res, 200, { service: serviceName, status: "running" });
        return;
      }

      if (method === "POST" && pathname === "/v1/users/register") {
        const body = await parseJsonBody(req);
        const contactEmail = body.contact_email || body.email;
        if (!contactEmail) {
          sendJson(res, 400, { error: "CONTRACT_INVALID_REGISTER_BODY" });
          return;
        }

        const user = {
          user_id: randomId("user"),
          contact_email: contactEmail,
          api_key: `sk_buyer_${crypto.randomBytes(12).toString("hex")}`,
          roles: ["buyer"],
          created_at: nowIso()
        };

        state.users.set(user.user_id, user);
        state.apiKeys.set(user.api_key, {
          type: "buyer",
          user_id: user.user_id,
          scopes: ["buyer"]
        });
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 201, user);
        return;
      }

      if (method === "GET" && pathname === "/v1/catalog/subagents") {
        const statusFilter = url.searchParams.get("status");
        const availabilityFilter = url.searchParams.get("availability_status");
        const items = Array.from(state.catalog.values())
          .map((item) => ({
            ...item,
            availability_status: resolveCatalogAvailability(item)
          }))
          .filter((item) => !statusFilter || item.status === statusFilter)
          .filter((item) => !availabilityFilter || item.availability_status === availabilityFilter)
          .map(sanitizeCatalogItem);

        sendJson(res, 200, { items });
        return;
      }

      const templateMatch = pathname.match(/^\/v1\/catalog\/subagents\/([^/]+)\/template-bundle$/);
      if (method === "GET" && templateMatch) {
        const subagentId = templateMatch[1];
        const templateRef = url.searchParams.get("template_ref");
        const catalogItem = state.catalog.get(subagentId);
        if (!catalogItem) {
          sendJson(res, 404, { error: "TEMPLATE_NOT_FOUND" });
          return;
        }
        if (templateRef && catalogItem.template_ref !== templateRef) {
          sendJson(res, 409, { error: "TEMPLATE_REF_MISMATCH" });
          return;
        }
        sendJson(res, 200, state.templates.get(catalogItem.template_ref));
        return;
      }

      if (method === "POST" && pathname === "/v1/tokens/task") {
        const auth = requireBuyer(req, res, state);
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        if (!body.request_id || !body.seller_id || !body.subagent_id) {
          sendJson(res, 400, { error: "CONTRACT_INVALID_TOKEN_REQUEST" });
          return;
        }

        const issued = issueTaskToken(state, auth, body);
        if (issued.error) {
          sendJson(res, issued.statusCode || 404, { error: issued.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 201, issued);
        return;
      }

      if (method === "POST" && pathname === "/v1/tokens/introspect") {
        const body = await parseJsonBody(req);
        const taskToken = body.task_token || body.token;
        const parsed = parseToken(state.tokenSecret, taskToken);

        const auth = parsed.claims?.seller_id
          ? requireSeller(req, res, state, {
              sellerId: parsed.claims.seller_id,
              subagentId: parsed.claims.subagent_id
            })
          : requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        if (auth.type !== "seller") {
          sendJson(res, 403, { error: "AUTH_SCOPE_FORBIDDEN" });
          return;
        }

        if (!parsed.valid) {
          sendJson(res, 200, {
            active: false,
            error: parsed.error,
            claims: parsed.claims || null
          });
          return;
        }

        sendJson(res, 200, {
          active: true,
          claims: parsed.claims
        });
        return;
      }

      const deliveryMetaMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/delivery-meta$/);
      if (method === "POST" && deliveryMetaMatch) {
        const auth = requireBuyer(req, res, state);
        if (!auth) {
          return;
        }

        const requestId = deliveryMetaMatch[1];
        const body = await parseJsonBody(req);
        const taskToken = body.task_token || body.token || null;
        if (!body.seller_id || !body.subagent_id) {
          sendJson(res, 400, { error: "CONTRACT_INVALID_DELIVERY_META_REQUEST" });
          return;
        }

        const catalogItem = state.catalog.get(body.subagent_id);
        if (!catalogItem || catalogItem.seller_id !== body.seller_id) {
          sendJson(res, 404, { error: "CATALOG_SUBAGENT_NOT_FOUND" });
          return;
        }

        if (taskToken) {
          const parsed = parseToken(state.tokenSecret, taskToken);
          if (!parsed.valid) {
            sendJson(res, 401, { error: parsed.error });
            return;
          }
          if (
            parsed.claims.request_id !== requestId ||
            parsed.claims.seller_id !== body.seller_id ||
            parsed.claims.subagent_id !== body.subagent_id ||
            parsed.claims.buyer_id !== auth.user_id
          ) {
            sendJson(res, 403, { error: "AUTH_RESOURCE_FORBIDDEN" });
            return;
          }
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }
        if (request.buyer_id && request.buyer_id !== auth.user_id) {
          sendJson(res, 403, { error: "AUTH_RESOURCE_FORBIDDEN" });
          return;
        }
        if (request.seller_id && request.seller_id !== body.seller_id) {
          sendJson(res, 409, { error: "REQUEST_BINDING_MISMATCH" });
          return;
        }
        if (request.subagent_id && request.subagent_id !== body.subagent_id) {
          sendJson(res, 409, { error: "REQUEST_BINDING_MISMATCH" });
          return;
        }
        request.buyer_id = auth.user_id;
        request.seller_id = body.seller_id;
        request.subagent_id = body.subagent_id;
        request.delivery_address = catalogItem.delivery_address;
        request.expected_signer_public_key_pem = catalogItem.seller_public_key_pem;
        appendRequestEvent(request, "DELIVERY_META_ISSUED", { actor_type: "buyer" });
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 200, {
          request_id: requestId,
          seller_id: body.seller_id,
          subagent_id: body.subagent_id,
          delivery_address: catalogItem.delivery_address,
          thread_hint: `req:${requestId}`,
          seller_public_key_pem: catalogItem.seller_public_key_pem
        });
        return;
      }

      const ackMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/ack$/);
      if (method === "POST" && ackMatch) {
        const requestId = ackMatch[1];
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }
        if (auth.type !== "seller") {
          sendJson(res, 403, { error: "AUTH_SCOPE_FORBIDDEN" });
          return;
        }
        const body = await parseJsonBody(req);
        if (!body.seller_id || !body.subagent_id) {
          sendJson(res, 400, { error: "CONTRACT_INVALID_ACK_REQUEST" });
          return;
        }
        if (auth.seller_id !== body.seller_id || !auth.subagent_ids.includes(body.subagent_id)) {
          sendJson(res, 403, { error: "AUTH_RESOURCE_FORBIDDEN" });
          return;
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }
        if (request.seller_id && request.seller_id !== body.seller_id) {
          sendJson(res, 409, { error: "REQUEST_BINDING_MISMATCH" });
          return;
        }
        if (request.subagent_id && request.subagent_id !== body.subagent_id) {
          sendJson(res, 409, { error: "REQUEST_BINDING_MISMATCH" });
          return;
        }
        request.seller_id = body.seller_id;
        request.subagent_id = body.subagent_id;
        if (!request.events.some((event) => event.event_type === "ACKED" && event.actor_type === "seller")) {
          appendRequestEvent(request, "ACKED", {
            actor_type: "seller",
            eta_hint_s: Number(body.eta_hint_s || 0)
          });
          await persistPlatformState(onStateChanged, state);
        }

        sendJson(res, 202, { accepted: true, request_id: requestId });
        return;
      }

      const eventMatch = pathname.match(/^\/v1\/requests\/([^/]+)\/events$/);
      if (method === "GET" && eventMatch) {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        const request = state.requests.get(eventMatch[1]);
        if (!request) {
          sendJson(res, 404, { error: "REQUEST_NOT_FOUND" });
          return;
        }
        if (auth.type === "buyer" && request.buyer_id !== auth.user_id) {
          sendJson(res, 403, { error: "AUTH_RESOURCE_FORBIDDEN" });
          return;
        }
        if (
          auth.type === "seller" &&
          (request.seller_id !== auth.seller_id ||
            (request.subagent_id && !auth.subagent_ids.includes(request.subagent_id)))
        ) {
          sendJson(res, 403, { error: "AUTH_RESOURCE_FORBIDDEN" });
          return;
        }

        sendJson(res, 200, { request_id: request.request_id, events: request.events, items: request.events });
        return;
      }

      const heartbeatMatch = pathname.match(/^\/v1\/sellers\/([^/]+)\/heartbeat$/);
      if (method === "POST" && heartbeatMatch) {
        const sellerId = heartbeatMatch[1];
        const auth = requireSeller(req, res, state, { sellerId });
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        const seller = state.sellers.get(sellerId);
        if (!seller) {
          sendJson(res, 404, { error: "SELLER_NOT_FOUND" });
          return;
        }

        const heartbeatAt = nowIso();
        seller.last_heartbeat_at = heartbeatAt;
        seller.availability_status = body.status || "healthy";

        for (const item of state.catalog.values()) {
          if (item.seller_id === sellerId) {
            item.last_heartbeat_at = heartbeatAt;
            item.availability_status = body.status || "healthy";
          }
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 202, {
          accepted: true,
          seller_id: sellerId,
          status: seller.availability_status,
          heartbeat_interval_s: HEARTBEAT_INTERVAL_S,
          last_heartbeat_at: heartbeatAt
        });
        return;
      }

      if (method === "POST" && pathname === "/v1/metrics/events") {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        const eventType = body.event_type || body.event_name;
        if (!eventType || !body.source) {
          sendJson(res, 400, { error: "CONTRACT_INVALID_METRIC_EVENT" });
          return;
        }

        const event = {
          id: randomId("evt"),
          event_type: eventType,
          source: body.source,
          request_id: body.request_id || null,
          recorded_at: nowIso()
        };
        state.metricsEvents.push(event);
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 202, { accepted: true, event });
        return;
      }

      if (method === "GET" && pathname === "/v1/metrics/summary") {
        const auth = requireAuth(req, res, state);
        if (!auth) {
          return;
        }

        sendJson(res, 200, {
          total_events: state.metricsEvents.length,
          by_type: state.metricsEvents.reduce((acc, event) => {
            acc[event.event_type] = (acc[event.event_type] || 0) + 1;
            return acc;
          }, {})
        });
        return;
      }

      sendJson(res, 404, { error: "not_found", path: pathname });
    } catch (error) {
      if (error.message === "invalid_json") {
        sendJson(res, 400, { error: "CONTRACT_INVALID_JSON" });
        return;
      }

      sendJson(res, 500, {
        error: "PLATFORM_API_INTERNAL_ERROR",
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

async function createOptionalPersistence(serviceName) {
  const connectionString = process.env.DATABASE_URL || null;
  if (connectionString) {
    const store = await createPostgresSnapshotStore({
      connectionString,
      serviceName
    });
    await store.migrate();
    return store;
  }

  const sqlitePath = process.env.SQLITE_DATABASE_PATH || null;
  if (!sqlitePath) {
    return null;
  }

  const store = await createSqliteSnapshotStore({
    databasePath: sqlitePath,
    serviceName
  });
  await store.migrate();
  return store;
}

if (isDirectRun()) {
  const port = Number(process.env.PORT || 8080);
  const serviceName = process.env.SERVICE_NAME || "platform-api";
  const state = createPlatformState();
  const persistence = await createOptionalPersistence(serviceName);
  if (persistence) {
    hydratePlatformState(state, await persistence.loadSnapshot());
  }
  const server = createPlatformServer({
    serviceName,
    state,
    onStateChanged: persistence
      ? async (currentState) => {
          await persistence.saveSnapshot(serializePlatformState(currentState));
        }
      : null
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port}`);
  });
  server.on("close", () => {
    if (persistence) {
      void persistence.saveSnapshot(serializePlatformState(state));
      void persistence.close();
    }
  });
}
