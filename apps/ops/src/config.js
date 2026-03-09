import crypto from "node:crypto";

import {
  ensureOpsDirectories,
  getOpsConfigFile,
  getOpsEnvFile,
  getSellerConfigFile,
  readEnvFile,
  readJsonFile,
  updateEnvFile,
  writeJsonFile
} from "../../../scripts/env-files.mjs";

export const DEFAULT_PORTS = Object.freeze({
  supervisor: 8079,
  relay: 8090,
  buyer: 8081,
  seller: 8082
});

function resolveDefaultPorts() {
  return {
    supervisor: Number(process.env.OPS_PORT_SUPERVISOR || DEFAULT_PORTS.supervisor),
    relay: Number(process.env.OPS_PORT_RELAY || DEFAULT_PORTS.relay),
    buyer: Number(process.env.OPS_PORT_BUYER || DEFAULT_PORTS.buyer),
    seller: Number(process.env.OPS_PORT_SELLER || DEFAULT_PORTS.seller)
  };
}

function randomSellerId() {
  return `seller_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function encodePemForEnv(pem) {
  return pem.replace(/\n/g, "\\n");
}

function decodePemFromEnv(pem) {
  return pem ? pem.replace(/\\n/g, "\n") : null;
}

export function generateSigningKeyPair() {
  const pair = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export function createDefaultOpsConfig(env = {}) {
  const ports = resolveDefaultPorts();
  const resolvedEnv = {
    ...process.env,
    ...env
  };
  return {
    platform: {
      base_url: resolvedEnv.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080"
    },
    buyer: {
      enabled: true,
      api_key: resolvedEnv.BUYER_PLATFORM_API_KEY || resolvedEnv.PLATFORM_API_KEY || null,
      contact_email: resolvedEnv.BUYER_CONTACT_EMAIL || null
    },
    seller: {
      enabled: false,
      seller_id: resolvedEnv.SELLER_ID || null,
      display_name: "Local Seller",
      subagents: []
    },
    runtime: {
      ports,
      external_relay: null
    }
  };
}

export function ensureOpsState() {
  ensureOpsDirectories();
  const envFile = getOpsEnvFile();
  const env = readEnvFile(envFile);
  const opsConfigFile = getOpsConfigFile();
  let config = readJsonFile(opsConfigFile, null);

  if (!config) {
    const legacySeller = readJsonFile(getSellerConfigFile(), null);
    config = createDefaultOpsConfig(env);
    if (legacySeller) {
      config.seller = {
        enabled: legacySeller.enabled !== false,
        seller_id: legacySeller.seller_id || env.SELLER_ID || null,
        display_name: legacySeller.display_name || "Local Seller",
        subagents: Array.isArray(legacySeller.subagents) ? legacySeller.subagents : []
      };
    }
  }

  config.platform ||= { base_url: env.PLATFORM_API_BASE_URL || process.env.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080" };
  config.buyer ||= {
    enabled: true,
    api_key: env.BUYER_PLATFORM_API_KEY || env.PLATFORM_API_KEY || process.env.BUYER_PLATFORM_API_KEY || process.env.PLATFORM_API_KEY || null,
    contact_email: env.BUYER_CONTACT_EMAIL || process.env.BUYER_CONTACT_EMAIL || null
  };
  config.seller ||= {
    enabled: false,
    seller_id: env.SELLER_ID || process.env.SELLER_ID || null,
    display_name: "Local Seller",
    subagents: []
  };
  const defaultPorts = resolveDefaultPorts();
  config.runtime ||= { ports: defaultPorts, external_relay: null };
  config.runtime.ports ||= defaultPorts;

  for (const [key, value] of Object.entries(defaultPorts)) {
    config.runtime.ports[key] ||= value;
  }

  return { envFile, opsConfigFile, env, config };
}

export function saveOpsState({ envFile, opsConfigFile, env, config }) {
  writeJsonFile(opsConfigFile, config);
  const updates = {
    PLATFORM_API_BASE_URL: config.platform?.base_url || env.PLATFORM_API_BASE_URL || null,
    BUYER_PLATFORM_API_KEY: config.buyer?.api_key || env.BUYER_PLATFORM_API_KEY || null,
    PLATFORM_API_KEY: config.buyer?.api_key || env.PLATFORM_API_KEY || null,
    BUYER_CONTACT_EMAIL: config.buyer?.contact_email || env.BUYER_CONTACT_EMAIL || null,
    SELLER_PLATFORM_API_KEY: env.SELLER_PLATFORM_API_KEY || null,
    SELLER_ID: config.seller?.seller_id || env.SELLER_ID || null,
    SUBAGENT_IDS: (config.seller?.subagents || []).map((item) => item.subagent_id).filter(Boolean).join(","),
    TRANSPORT_BASE_URL:
      config.runtime?.external_relay?.base_url ||
      `http://127.0.0.1:${config.runtime?.ports?.relay || DEFAULT_PORTS.relay}`,
    PORT: null
  };
  return updateEnvFile(envFile, updates);
}

export function ensureSellerIdentity(state, { sellerId = null, displayName = null } = {}) {
  const { env, config } = state;
  const currentSellerId = sellerId || config.seller?.seller_id || env.SELLER_ID || randomSellerId();
  config.seller ||= {};
  config.seller.seller_id = currentSellerId;
  config.seller.display_name = displayName || config.seller.display_name || "Local Seller";
  config.seller.subagents ||= [];

  if (!env.SELLER_SIGNING_PUBLIC_KEY_PEM || !env.SELLER_SIGNING_PRIVATE_KEY_PEM) {
    const signing = generateSigningKeyPair();
    updateEnvFile(state.envFile, {
      SELLER_SIGNING_PUBLIC_KEY_PEM: encodePemForEnv(signing.publicKeyPem),
      SELLER_SIGNING_PRIVATE_KEY_PEM: encodePemForEnv(signing.privateKeyPem),
      SELLER_ID: currentSellerId
    });
    state.env = readEnvFile(state.envFile);
  }

  return {
    seller_id: currentSellerId,
    display_name: config.seller.display_name,
    public_key_pem: decodePemFromEnv(state.env.SELLER_SIGNING_PUBLIC_KEY_PEM),
    private_key_pem: decodePemFromEnv(state.env.SELLER_SIGNING_PRIVATE_KEY_PEM)
  };
}

export function upsertSubagent(state, definition) {
  state.config.seller ||= { enabled: false, seller_id: null, display_name: "Local Seller", subagents: [] };
  state.config.seller.subagents ||= [];
  state.config.seller.subagents = [
    ...state.config.seller.subagents.filter((item) => item.subagent_id !== definition.subagent_id),
    definition
  ];
  return definition;
}

export function setSubagentEnabled(state, subagentId, enabled) {
  state.config.seller ||= { enabled: false, seller_id: null, display_name: "Local Seller", subagents: [] };
  state.config.seller.subagents ||= [];
  const item = state.config.seller.subagents.find((entry) => entry.subagent_id === subagentId);
  if (!item) {
    return null;
  }
  item.enabled = enabled;
  return item;
}

export function removeSubagent(state, subagentId) {
  state.config.seller ||= { enabled: false, seller_id: null, display_name: "Local Seller", subagents: [] };
  state.config.seller.subagents ||= [];
  const existing = state.config.seller.subagents.find((entry) => entry.subagent_id === subagentId);
  if (!existing) {
    return null;
  }
  state.config.seller.subagents = state.config.seller.subagents.filter((entry) => entry.subagent_id !== subagentId);
  return existing;
}
