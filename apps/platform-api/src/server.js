import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
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

function createSellerIdentity({ sellerId, subagentId, templateRef, displayName, deliveryAddress }) {
  const signing = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const sellerApiKey = `sk_seller_${crypto.randomBytes(12).toString("hex")}`;
  const sellerUserId = randomId("user");
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
      seller_public_key_pem: publicKeyPem,
      delivery_address: deliveryAddress
    },
    signing: {
      publicKeyPem,
      privateKeyPem
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

export function createPlatformState(options = {}) {
  const tokenSecret = options.tokenSecret || crypto.randomBytes(32);
  const tokenTtlSeconds = Number(options.tokenTtlSeconds || process.env.TOKEN_TTL_SECONDS || 300);

  const bootstrapSellers = [
    createSellerIdentity({
      sellerId: "seller_foxlab",
      subagentId: "foxlab.text.classifier.v1",
      templateRef: "foxlab/text-classifier@v1",
      displayName: "Foxlab Text Classifier",
      deliveryAddress: "foxlab+classifier@local-relay.test"
    }),
    createSellerIdentity({
      sellerId: "seller_northwind",
      subagentId: "northwind.copywriter.v1",
      templateRef: "northwind/copywriter@v1",
      displayName: "Northwind Copywriter",
      deliveryAddress: "northwind+copywriter@local-relay.test"
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
  const request = getOrCreateRequest(state, body.request_id);
  request.buyer_id = auth.user_id;
  request.seller_id = body.seller_id;
  request.subagent_id = body.subagent_id;
  appendRequestEvent(request, "TASK_TOKEN_ISSUED", { actor_type: "buyer" });

  return { task_token: token, claims };
}

export function createPlatformServer({ state = createPlatformState(), serviceName = "platform-api" } = {}) {
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
          sendJson(res, 404, { error: issued.error });
          return;
        }

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

        const request = getOrCreateRequest(state, requestId);
        request.buyer_id = auth.user_id;
        request.seller_id = body.seller_id;
        request.subagent_id = body.subagent_id;
        request.delivery_address = catalogItem.delivery_address;
        request.expected_signer_public_key_pem = catalogItem.seller_public_key_pem;
        appendRequestEvent(request, "DELIVERY_META_ISSUED", { actor_type: "buyer" });

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
        const body = await parseJsonBody(req);
        const auth = requireSeller(req, res, state, {
          sellerId: body.seller_id,
          subagentId: body.subagent_id
        });
        if (!auth) {
          return;
        }

        const request = getOrCreateRequest(state, requestId);
        request.seller_id = body.seller_id;
        request.subagent_id = body.subagent_id;
        appendRequestEvent(request, "ACKED", {
          actor_type: "seller",
          eta_hint_s: Number(body.eta_hint_s || 0)
        });

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

if (isDirectRun()) {
  const port = Number(process.env.PORT || 8080);
  const serviceName = process.env.SERVICE_NAME || "platform-api";
  const server = createPlatformServer({ serviceName });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port}`);
  });
}
