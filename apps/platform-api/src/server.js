import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresSnapshotStore } from "@croc/postgres-store";
import { createSqliteSnapshotStore } from "@croc/sqlite-store";
import { buildOpsEnvSearchPaths, loadEnvFiles } from "../../../scripts/env-files.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");

loadEnvFiles([
  ...buildOpsEnvSearchPaths(ROOT_DIR, "platform"),
  path.join(ROOT_DIR, "deploy/all-in-one/.env"),
  path.join(ROOT_DIR, "deploy/all-in-one/.env.local")
]);

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

function sendError(res, statusCode, code, message, { retryable = false, ...extra } = {}) {
  sendJson(res, statusCode, { error: { code, message, retryable }, ...extra });
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
    return { valid: false, error: { code: "AUTH_TOKEN_INVALID", message: "token format or signature is invalid", retryable: false } };
  }

  const [payload, signature] = token.split(".", 2);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const expectedBytes = Buffer.from(expected);
  const signatureBytes = Buffer.from(signature || "");

  if (expectedBytes.length !== signatureBytes.length || !crypto.timingSafeEqual(expectedBytes, signatureBytes)) {
    return { valid: false, error: { code: "AUTH_TOKEN_INVALID", message: "token format or signature is invalid", retryable: false } };
  }

  try {
    const claims = JSON.parse(decodeBase64Url(payload));
    if (typeof claims.exp !== "number" || Date.now() >= claims.exp * 1000) {
      return { valid: false, error: { code: "AUTH_TOKEN_EXPIRED", message: "token has expired", retryable: false }, claims };
    }
    return { valid: true, claims };
  } catch {
    return { valid: false, error: { code: "AUTH_TOKEN_INVALID", message: "token format or signature is invalid", retryable: false } };
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
  taskTypes = [],
  capabilities = [],
  tags = [],
  inputSchema = null,
  outputSchema = null,
  apiKey = null,
  ownerUserId = null,
  contactEmail = null,
  supportEmail = null,
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
      contact_email: contactEmail || `${sellerId}@test.local`,
      support_email: supportEmail || `support+${sellerId}@test.local`
    },
    catalogItem: {
      seller_id: sellerId,
      subagent_id: subagentId,
      display_name: displayName,
      status: "enabled",
      availability_status: "healthy",
      last_heartbeat_at: lastHeartbeatAt,
      template_ref: templateRef,
      task_types: taskTypes,
      capabilities,
      tags,
      input_schema: inputSchema,
      output_schema: outputSchema,
      seller_public_key_pem: keyPair.publicKeyPem,
      delivery_address: deliveryAddress
    },
    signing: {
      publicKeyPem: keyPair.publicKeyPem,
      privateKeyPem: keyPair.privateKeyPem
    }
  };
}

function createTemplateBundle(templateRef, options = {}) {
  return {
    template_ref: templateRef,
    input_schema: options.inputSchema || {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string" },
        context: { type: "object" }
      }
    },
    output_schema: options.outputSchema || {
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

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function registerBuyerUser(state, body) {
  const contactEmail = body.contact_email || body.email;
  if (!contactEmail) {
    return { error: { code: "CONTRACT_INVALID_REGISTER_BODY", message: "contact_email is required", retryable: false }, statusCode: 400 };
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

  return user;
}

function addUserRole(state, userId, role) {
  const user = state.users.get(userId);
  if (!user) {
    return null;
  }
  const roles = new Set(user.roles || []);
  roles.add(role);
  user.roles = Array.from(roles);
  for (const apiKeyRecord of state.apiKeys.values()) {
    if (apiKeyRecord.type === "buyer" && apiKeyRecord.user_id === userId) {
      const scopes = new Set(apiKeyRecord.scopes || ["buyer"]);
      scopes.add(role);
      apiKeyRecord.scopes = Array.from(scopes);
    }
  }
  return user;
}

async function persistPlatformState(onStateChanged, state) {
  if (typeof onStateChanged === "function") {
    await onStateChanged(state);
  }
}

export function createPlatformState(options = {}) {
  const tokenSecret = options.tokenSecret || crypto.randomBytes(32);
  const tokenTtlSeconds = Number(options.tokenTtlSeconds || process.env.TOKEN_TTL_SECONDS || 300);
  const adminApiKey =
    options.adminApiKey || process.env.PLATFORM_ADMIN_API_KEY || `sk_admin_${crypto.randomBytes(12).toString("hex")}`;
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
      taskTypes: ["text_classify"],
      capabilities: ["text.classify", "document.classify"],
      tags: ["nlp", "classification"],
      apiKey: process.env.BOOTSTRAP_SELLER_API_KEY || null,
      ownerUserId: process.env.BOOTSTRAP_SELLER_OWNER_USER_ID || null,
      signing: bootstrapSellerSigning
    }),
    createSellerIdentity({
      sellerId: "seller_northwind",
      subagentId: "northwind.copywriter.v1",
      templateRef: "northwind/copywriter@v1",
      displayName: "Northwind Copywriter",
      deliveryAddress: "local://relay/seller_northwind/northwind.copywriter.v1",
      taskTypes: ["copywrite"],
      capabilities: ["marketing.copywrite", "text.generate"],
      tags: ["marketing", "copywriting"]
    })
  ];

  const users = new Map();
  const apiKeys = new Map();
  const sellers = new Map();
  const catalog = new Map();
  const templates = new Map();
  const requests = new Map();
  const metricsEvents = [];
  const auditEvents = [];
  const reviewEvents = [];

  apiKeys.set(adminApiKey, {
    type: "admin",
    admin_id: "platform_admin",
    scopes: ["admin", "operator"]
  });

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
    templates.set(
      item.catalogItem.template_ref,
      createTemplateBundle(item.catalogItem.template_ref, {
        inputSchema: item.catalogItem.input_schema,
        outputSchema: item.catalogItem.output_schema
      })
    );
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
    auditEvents,
    reviewEvents,
    adminApiKey,
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
    metricsEvents: state.metricsEvents,
    auditEvents: state.auditEvents,
    reviewEvents: state.reviewEvents
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
  state.auditEvents.splice(0, state.auditEvents.length, ...(snapshot.auditEvents || []));
  state.reviewEvents.splice(0, state.reviewEvents.length, ...(snapshot.reviewEvents || []));
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
    sendError(res, 401, "AUTH_UNAUTHORIZED", "API key is missing or invalid");
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
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required buyer scope");
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
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required seller scope");
    return null;
  }
  if (sellerId && auth.seller_id !== sellerId) {
    sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "seller_id does not match caller identity");
    return null;
  }
  if (subagentId && !auth.subagent_ids.includes(subagentId)) {
    sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "subagent_id is not owned by caller");
    return null;
  }
  return auth;
}

function requireOperator(req, res, state) {
  const auth = requireAuth(req, res, state);
  if (!auth) {
    return null;
  }
  if (auth.type === "admin") {
    return auth;
  }
  if (auth.type !== "buyer") {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller lacks the required scope");
    return null;
  }
  const user = state.users.get(auth.user_id);
  if (!(user?.roles || []).includes("admin")) {
    sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "caller does not have admin role");
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

function buildSellerAdminSummary(seller, catalogItems = []) {
  const runtimeStatus = catalogItems.some((item) => item.status === "enabled") ? "enabled" : "disabled";
  return {
    seller_id: seller.seller_id,
    owner_user_id: seller.owner_user_id,
    contact_email: seller.contact_email,
    support_email: seller.support_email,
    status: runtimeStatus,
    availability_status: seller.availability_status,
    last_heartbeat_at: seller.last_heartbeat_at,
    subagent_ids: seller.subagent_ids,
    subagent_count: catalogItems.length,
    subagents: catalogItems.map((item) => ({
      subagent_id: item.subagent_id,
      display_name: item.display_name,
      status: item.status,
      availability_status: resolveCatalogAvailability(item),
      task_types: item.task_types || [],
      capabilities: item.capabilities || [],
      tags: item.tags || []
    }))
  };
}

function buildRequestAdminSummary(request) {
  return {
    request_id: request.request_id,
    buyer_id: request.buyer_id,
    seller_id: request.seller_id,
    subagent_id: request.subagent_id,
    event_count: Array.isArray(request.events) ? request.events.length : 0,
    latest_event: Array.isArray(request.events) && request.events.length > 0 ? request.events[request.events.length - 1] : null
  };
}

function setSellerCatalogStatus(state, sellerId, status) {
  const seller = state.sellers.get(sellerId);
  if (!seller) {
    return null;
  }

  for (const item of state.catalog.values()) {
    if (item.seller_id === sellerId) {
      item.status = status;
    }
  }

  return seller;
}

function describeActor(auth) {
  if (!auth) {
    return { actor_type: "system", actor_id: null };
  }
  if (auth.type === "admin") {
    return { actor_type: "admin", actor_id: auth.admin_id || "platform_admin" };
  }
  if (auth.type === "buyer") {
    return { actor_type: "buyer", actor_id: auth.user_id };
  }
  return { actor_type: auth.type || "unknown", actor_id: auth.user_id || auth.seller_id || null };
}

function appendAuditEvent(state, auth, action, target, detail = {}) {
  state.auditEvents.push({
    id: randomId("audit"),
    action,
    target_type: target.type,
    target_id: target.id,
    recorded_at: nowIso(),
    ...describeActor(auth),
    ...detail
  });
}

function appendReviewEvent(state, auth, reviewStatus, target, detail = {}) {
  state.reviewEvents.push({
    id: randomId("review"),
    review_status: reviewStatus,
    target_type: target.type,
    target_id: target.id,
    recorded_at: nowIso(),
    ...describeActor(auth),
    ...detail
  });
}

function matchesQuery(value, query) {
  if (!query) {
    return true;
  }
  return JSON.stringify(value).toLowerCase().includes(query.toLowerCase());
}

function parsePagination(url) {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  return { limit, offset };
}

function paginateItems(items, { limit, offset }) {
  const sliced = items.slice(offset, offset + limit);
  return {
    items: sliced,
    pagination: {
      total: items.length,
      limit,
      offset,
      has_more: offset + sliced.length < items.length
    }
  };
}

function issueTaskToken(state, auth, body) {
  const catalogItem = state.catalog.get(body.subagent_id);
  if (!catalogItem || catalogItem.seller_id !== body.seller_id || catalogItem.status !== "enabled") {
    return { error: { code: "CATALOG_SUBAGENT_NOT_FOUND", message: "subagent not found or not enabled", retryable: false } };
  }

  const request = getOrCreateRequest(state, body.request_id);
  if (request.buyer_id && request.buyer_id !== auth.user_id) {
    return { error: { code: "AUTH_RESOURCE_FORBIDDEN", message: "request is owned by another buyer", retryable: false }, statusCode: 403 };
  }
  if (request.seller_id && request.seller_id !== body.seller_id) {
    return { error: { code: "REQUEST_BINDING_MISMATCH", message: "seller_id or subagent_id does not match existing request", retryable: false }, statusCode: 409 };
  }
  if (request.subagent_id && request.subagent_id !== body.subagent_id) {
    return { error: { code: "REQUEST_BINDING_MISMATCH", message: "seller_id or subagent_id does not match existing request", retryable: false }, statusCode: 409 };
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

function registerSellerIdentity(state, body, auth = null) {
  if (!body.seller_id || !body.subagent_id || !body.display_name || !body.seller_public_key_pem) {
    return { error: { code: "CONTRACT_INVALID_SELLER_REGISTER_BODY", message: "seller_id, subagent_id, display_name, and seller_public_key_pem are required", retryable: false }, statusCode: 400 };
  }
  if (state.catalog.has(body.subagent_id)) {
    return { error: { code: "SUBAGENT_ID_ALREADY_EXISTS", message: "a subagent with this id is already registered", retryable: false }, statusCode: 409 };
  }

  const existingSeller = state.sellers.get(body.seller_id);
  const sellerApiKey = existingSeller?.api_key || `sk_seller_${crypto.randomBytes(12).toString("hex")}`;
  const ownerUserId = existingSeller?.owner_user_id || auth?.user_id || body.owner_user_id || randomId("user");
  const templateRef = body.template_ref || `${body.subagent_id}@v1`;
  const taskTypes = normalizeStringList(body.task_types);
  const capabilities = normalizeStringList(body.capabilities);
  const tags = normalizeStringList(body.tags);
  const heartbeatAt = nowIso();

  if (existingSeller) {
    if (!auth) {
      return { error: { code: "AUTH_UNAUTHORIZED", message: "authentication required to add subagent to existing seller", retryable: false }, statusCode: 401 };
    }
    if (auth?.type === "buyer" && existingSeller.owner_user_id !== auth.user_id) {
      return { error: { code: "AUTH_RESOURCE_FORBIDDEN", message: "caller does not own this seller identity", retryable: false }, statusCode: 403 };
    }
    if (auth?.type === "seller" && auth.seller_id !== existingSeller.seller_id) {
      return { error: { code: "AUTH_RESOURCE_FORBIDDEN", message: "caller does not own this seller identity", retryable: false }, statusCode: 403 };
    }
  }

  const seller = existingSeller || {
    seller_id: body.seller_id,
    owner_user_id: ownerUserId,
    api_key: sellerApiKey,
    scopes: ["seller"],
    subagent_ids: [],
    last_heartbeat_at: heartbeatAt,
    availability_status: "healthy",
    contact_email: body.contact_email || state.users.get(ownerUserId)?.contact_email || `${body.seller_id}@test.local`,
    support_email: body.support_email || `support+${body.seller_id}@test.local`
  };
  seller.subagent_ids = Array.from(new Set([...(seller.subagent_ids || []), body.subagent_id]));
  seller.last_heartbeat_at = seller.last_heartbeat_at || heartbeatAt;
  seller.availability_status ||= "healthy";
  const catalogItem = {
    seller_id: body.seller_id,
    subagent_id: body.subagent_id,
    display_name: body.display_name,
    status: "disabled",
    availability_status: "healthy",
    last_heartbeat_at: heartbeatAt,
    template_ref: templateRef,
    task_types: taskTypes,
    capabilities,
    tags,
    input_schema: body.input_schema || null,
    output_schema: body.output_schema || null,
    seller_public_key_pem: body.seller_public_key_pem,
    delivery_address: body.delivery_address || `local://relay/${body.seller_id}/${body.subagent_id}`
  };

  state.sellers.set(seller.seller_id, seller);
  state.apiKeys.set(sellerApiKey, {
    type: "seller",
    seller_id: seller.seller_id,
    owner_user_id: ownerUserId,
    scopes: seller.scopes,
    subagent_ids: seller.subagent_ids
  });
  state.catalog.set(catalogItem.subagent_id, catalogItem);
  state.templates.set(
    templateRef,
    createTemplateBundle(templateRef, {
      inputSchema: catalogItem.input_schema,
      outputSchema: catalogItem.output_schema
    })
  );

  if (auth?.user_id) {
    addUserRole(state, auth.user_id, "seller");
  }

  if (!existingSeller) {
    appendReviewEvent(
      state,
      auth,
      "pending",
      { type: "seller", id: seller.seller_id },
      {
        seller_id: seller.seller_id,
        subagent_id: catalogItem.subagent_id,
        reason: body.review_reason || body.reason || null
      }
    );
  }
  appendReviewEvent(
    state,
    auth,
    "pending",
    { type: "subagent", id: catalogItem.subagent_id },
    {
      seller_id: seller.seller_id,
      subagent_id: catalogItem.subagent_id,
      reason: body.review_reason || body.reason || null
    }
  );

  return {
    seller_id: seller.seller_id,
    subagent_id: catalogItem.subagent_id,
    api_key: sellerApiKey,
    owner_user_id: ownerUserId,
    delivery_address: catalogItem.delivery_address,
    seller_public_key_pem: catalogItem.seller_public_key_pem,
    status: catalogItem.status,
    review_status: "pending",
    task_types: taskTypes,
    capabilities,
    tags
  };
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
        const user = registerBuyerUser(state, body);
        if (user.error) {
          sendJson(res, user.statusCode || 400, { error: user.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);

        sendJson(res, 201, user);
        return;
      }

      if (method === "POST" && pathname === "/v1/sellers/register") {
        const body = await parseJsonBody(req);
        const auth = resolveAuth(req, state);
        if (auth && auth.type !== "buyer" && auth.type !== "seller") {
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only buyer or seller callers may register");
          return;
        }
        const registered = registerSellerIdentity(state, body, auth);
        if (registered.error) {
          sendJson(res, registered.statusCode || 400, { error: registered.error });
          return;
        }
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 201, registered);
        return;
      }

      if (method === "GET" && pathname === "/v1/catalog/subagents") {
        const statusFilter = url.searchParams.get("status") || "enabled";
        const availabilityFilter = url.searchParams.get("availability_status");
        const taskTypeFilter = url.searchParams.get("task_type");
        const capabilityFilter = url.searchParams.get("capability");
        const tagFilter = url.searchParams.get("tag");
        const items = Array.from(state.catalog.values())
          .map((item) => ({
            ...item,
            availability_status: resolveCatalogAvailability(item)
          }))
          .filter((item) => !statusFilter || item.status === statusFilter)
          .filter((item) => !availabilityFilter || item.availability_status === availabilityFilter)
          .filter((item) => !taskTypeFilter || (item.task_types || []).includes(taskTypeFilter))
          .filter((item) => !capabilityFilter || (item.capabilities || []).includes(capabilityFilter))
          .filter((item) => !tagFilter || (item.tags || []).includes(tagFilter))
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
          sendError(res, 404, "TEMPLATE_NOT_FOUND", "subagent or template not found");
          return;
        }
        if (templateRef && catalogItem.template_ref !== templateRef) {
          sendError(res, 409, "TEMPLATE_REF_MISMATCH", "template_ref does not match catalog entry");
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
          sendError(res, 400, "CONTRACT_INVALID_TOKEN_REQUEST", "request_id, seller_id, and subagent_id are required");
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
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only seller callers may introspect tokens");
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
          sendError(res, 400, "CONTRACT_INVALID_DELIVERY_META_REQUEST", "seller_id and subagent_id are required");
          return;
        }

        const catalogItem = state.catalog.get(body.subagent_id);
        if (!catalogItem || catalogItem.seller_id !== body.seller_id || catalogItem.status !== "enabled") {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found or not enabled");
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
            sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "token claims do not match request parameters");
            return;
          }
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (request.buyer_id && request.buyer_id !== auth.user_id) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "request is owned by another buyer");
          return;
        }
        if (request.seller_id && request.seller_id !== body.seller_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "seller_id does not match existing request");
          return;
        }
        if (request.subagent_id && request.subagent_id !== body.subagent_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "subagent_id does not match existing request");
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
          sendError(res, 403, "AUTH_SCOPE_FORBIDDEN", "only seller callers may ack requests");
          return;
        }
        const body = await parseJsonBody(req);
        if (!body.seller_id || !body.subagent_id) {
          sendError(res, 400, "CONTRACT_INVALID_ACK_REQUEST", "seller_id and subagent_id are required");
          return;
        }
        if (auth.seller_id !== body.seller_id || !auth.subagent_ids.includes(body.subagent_id)) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "caller does not own the specified seller or subagent");
          return;
        }

        const request = state.requests.get(requestId);
        if (!request) {
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (request.seller_id && request.seller_id !== body.seller_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "seller_id does not match existing request");
          return;
        }
        if (request.subagent_id && request.subagent_id !== body.subagent_id) {
          sendError(res, 409, "REQUEST_BINDING_MISMATCH", "subagent_id does not match existing request");
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
          sendError(res, 404, "REQUEST_NOT_FOUND", "no request found with this id");
          return;
        }
        if (auth.type === "buyer" && request.buyer_id !== auth.user_id) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "request is owned by another buyer");
          return;
        }
        if (
          auth.type === "seller" &&
          (request.seller_id !== auth.seller_id ||
            (request.subagent_id && !auth.subagent_ids.includes(request.subagent_id)))
        ) {
          sendError(res, 403, "AUTH_RESOURCE_FORBIDDEN", "seller does not own this request");
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
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
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
          sendError(res, 400, "CONTRACT_INVALID_METRIC_EVENT", "event_type and source are required");
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

      if (method === "GET" && pathname === "/v1/admin/sellers") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const status = url.searchParams.get("status");
        const availabilityStatus = url.searchParams.get("availability_status");
        const ownerUserId = url.searchParams.get("owner_user_id");

        const items = Array.from(state.sellers.values())
          .map((seller) =>
            buildSellerAdminSummary(
              seller,
              Array.from(state.catalog.values()).filter((item) => item.seller_id === seller.seller_id)
            )
          )
          .filter((item) => !status || item.status === status)
          .filter((item) => !availabilityStatus || item.availability_status === availabilityStatus)
          .filter((item) => !ownerUserId || item.owner_user_id === ownerUserId)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/subagents") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const status = url.searchParams.get("status");
        const availabilityStatus = url.searchParams.get("availability_status");
        const sellerId = url.searchParams.get("seller_id");
        const capability = url.searchParams.get("capability");
        const tag = url.searchParams.get("tag");

        const items = Array.from(state.catalog.values())
          .map((item) => ({
            ...item,
            availability_status: resolveCatalogAvailability(item)
          }))
          .filter((item) => !status || item.status === status)
          .filter((item) => !availabilityStatus || item.availability_status === availabilityStatus)
          .filter((item) => !sellerId || item.seller_id === sellerId)
          .filter((item) => !capability || (item.capabilities || []).includes(capability))
          .filter((item) => !tag || (item.tags || []).includes(tag))
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/requests") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const buyerId = url.searchParams.get("buyer_id");
        const sellerId = url.searchParams.get("seller_id");
        const subagentId = url.searchParams.get("subagent_id");
        const eventType = url.searchParams.get("event_type");

        const items = Array.from(state.requests.values())
          .map(buildRequestAdminSummary)
          .filter((item) => !buyerId || item.buyer_id === buyerId)
          .filter((item) => !sellerId || item.seller_id === sellerId)
          .filter((item) => !subagentId || item.subagent_id === subagentId)
          .filter((item) => !eventType || item.latest_event?.event_type === eventType)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/reviews") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const reviewStatus = url.searchParams.get("review_status");
        const targetType = url.searchParams.get("target_type");
        const targetId = url.searchParams.get("target_id");

        const items = state.reviewEvents
          .slice()
          .reverse()
          .filter((item) => !reviewStatus || item.review_status === reviewStatus)
          .filter((item) => !targetType || item.target_type === targetType)
          .filter((item) => !targetId || item.target_id === targetId)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      const adminRoleGrantMatch = pathname.match(/^\/v1\/admin\/users\/([^/]+)\/roles$/);
      if (method === "POST" && adminRoleGrantMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }

        const body = await parseJsonBody(req);
        const role = body.role || body.add_role;
        if (!role) {
          sendError(res, 400, "CONTRACT_INVALID_ROLE_GRANT", "role is required");
          return;
        }

        const user = addUserRole(state, adminRoleGrantMatch[1], role);
        if (!user) {
          sendError(res, 404, "USER_NOT_FOUND", "no user found with this id");
          return;
        }
        appendAuditEvent(state, auth, "user.role.granted", { type: "user", id: user.user_id }, { role });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { user_id: user.user_id, roles: user.roles });
        return;
      }

      if (method === "GET" && pathname === "/v1/admin/audit-events") {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const { limit, offset } = parsePagination(url);
        const q = url.searchParams.get("q");
        const action = url.searchParams.get("action");
        const actorType = url.searchParams.get("actor_type");
        const targetType = url.searchParams.get("target_type");

        const items = state.auditEvents
          .slice()
          .reverse()
          .filter((item) => !action || item.action === action)
          .filter((item) => !actorType || item.actor_type === actorType)
          .filter((item) => !targetType || item.target_type === targetType)
          .filter((item) => matchesQuery(item, q));
        sendJson(res, 200, paginateItems(items, { limit, offset }));
        return;
      }

      const adminSellerDisableMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/disable$/);
      if (method === "POST" && adminSellerDisableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const seller = setSellerCatalogStatus(state, adminSellerDisableMatch[1], "disabled");
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        appendAuditEvent(state, auth, "seller.disabled", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { seller_id: seller.seller_id, status: "disabled" });
        return;
      }

      const adminSellerApproveMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/approve$/);
      if (method === "POST" && adminSellerApproveMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const seller = setSellerCatalogStatus(state, adminSellerApproveMatch[1], "enabled");
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        appendAuditEvent(state, auth, "seller.approved", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "approved", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { seller_id: seller.seller_id, status: "enabled" });
        return;
      }

      const adminSellerRejectMatch = pathname.match(/^\/v1\/admin\/sellers\/([^/]+)\/reject$/);
      if (method === "POST" && adminSellerRejectMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const seller = setSellerCatalogStatus(state, adminSellerRejectMatch[1], "disabled");
        if (!seller) {
          sendError(res, 404, "SELLER_NOT_FOUND", "no seller found with this id");
          return;
        }
        appendAuditEvent(state, auth, "seller.rejected", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "rejected", { type: "seller", id: seller.seller_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { seller_id: seller.seller_id, status: "disabled", review_status: "rejected" });
        return;
      }

      const adminSubagentDisableMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/disable$/);
      if (method === "POST" && adminSubagentDisableMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminSubagentDisableMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        item.status = "disabled";
        appendAuditEvent(state, auth, "subagent.disabled", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { subagent_id: item.subagent_id, status: item.status });
        return;
      }

      const adminSubagentApproveMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/approve$/);
      if (method === "POST" && adminSubagentApproveMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminSubagentApproveMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        item.status = "enabled";
        appendAuditEvent(state, auth, "subagent.approved", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "approved", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { subagent_id: item.subagent_id, status: item.status });
        return;
      }

      const adminSubagentRejectMatch = pathname.match(/^\/v1\/admin\/subagents\/([^/]+)\/reject$/);
      if (method === "POST" && adminSubagentRejectMatch) {
        const auth = requireOperator(req, res, state);
        if (!auth) {
          return;
        }
        const body = await parseJsonBody(req);

        const item = state.catalog.get(adminSubagentRejectMatch[1]);
        if (!item) {
          sendError(res, 404, "CATALOG_SUBAGENT_NOT_FOUND", "subagent not found in catalog");
          return;
        }
        item.status = "disabled";
        appendAuditEvent(state, auth, "subagent.rejected", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        appendReviewEvent(state, auth, "rejected", { type: "subagent", id: item.subagent_id }, { reason: body.reason || null });
        await persistPlatformState(onStateChanged, state);
        sendJson(res, 200, { subagent_id: item.subagent_id, status: item.status, review_status: "rejected" });
        return;
      }

      sendError(res, 404, "not_found", "no matching route", { path: pathname });
    } catch (error) {
      if (error.message === "invalid_json") {
        sendError(res, 400, "CONTRACT_INVALID_JSON", "request body is not valid JSON");
        return;
      }

      sendError(res, 500, "PLATFORM_API_INTERNAL_ERROR", error instanceof Error ? error.message : "unknown_error", { retryable: true });
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
