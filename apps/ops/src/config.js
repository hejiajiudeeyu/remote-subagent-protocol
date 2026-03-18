import crypto from "node:crypto";

import {
  ensureOpsDirectories,
  getOpsConfigFile,
  getOpsEnvFile,
  getOpsSecretsFile,
  getSellerConfigFile,
  readEnvFile,
  readJsonFile,
  secretStoreExists,
  unlockSecretStore,
  updateEnvFile,
  writeJsonFile,
  writeSecretValues
} from "@delexec/runtime-utils";

export const DEFAULT_PORTS = Object.freeze({
  supervisor: 8079,
  relay: 8090,
  buyer: 8081,
  seller: 8082
});

export const DEFAULT_TRANSPORT_TYPE = "local";
export const DEFAULT_EMAIL_PROVIDER = "emailengine";
export const DEFAULT_EMAIL_POLL_INTERVAL_MS = 5000;

const TRANSPORT_SECRET_ENV_KEYS = Object.freeze({
  emailengine: {
    access_token: "TRANSPORT_EMAILENGINE_ACCESS_TOKEN"
  },
  gmail: {
    client_secret: "TRANSPORT_GMAIL_CLIENT_SECRET",
    refresh_token: "TRANSPORT_GMAIL_REFRESH_TOKEN"
  }
});

export const OPS_SECRET_KEYS = Object.freeze({
  buyer_api_key: "buyer_api_key",
  seller_platform_api_key: "seller_platform_api_key",
  transport_emailengine_access_token: "transport_emailengine_access_token",
  transport_gmail_client_secret: "transport_gmail_client_secret",
  transport_gmail_refresh_token: "transport_gmail_refresh_token",
  platform_admin_api_key: "platform_admin_api_key"
});

const LEGACY_SECRET_CONFIG_PATHS = Object.freeze({
  [OPS_SECRET_KEYS.buyer_api_key]: ["buyer", "api_key"],
  [OPS_SECRET_KEYS.platform_admin_api_key]: ["platform_console", "admin_api_key"]
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

function normalizedString(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function normalizePollInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_EMAIL_POLL_INTERVAL_MS;
  }
  return Math.trunc(parsed);
}

function defaultTransportConfig() {
  return {
    type: DEFAULT_TRANSPORT_TYPE,
    relay_http: {
      base_url: null
    },
    email: {
      provider: DEFAULT_EMAIL_PROVIDER,
      mode: "shared_mailbox",
      sender: null,
      receiver: null,
      poll_interval_ms: DEFAULT_EMAIL_POLL_INTERVAL_MS,
      emailengine: {
        base_url: null,
        account: null
      },
      gmail: {
        client_id: null,
        user: null
      }
    }
  };
}

function getLegacyTransportBaseUrl(config, env) {
  return (
    normalizedString(config?.runtime?.external_relay?.base_url) ||
    normalizedString(env.TRANSPORT_BASE_URL) ||
    null
  );
}

export function normalizeTransportConfig(config = {}, env = {}) {
  const defaults = defaultTransportConfig();
  const source = config?.runtime?.transport || null;
  const legacyBaseUrl = getLegacyTransportBaseUrl(config, env);
  const type = normalizedString(source?.type) || (legacyBaseUrl ? "relay_http" : DEFAULT_TRANSPORT_TYPE);
  const provider = normalizedString(source?.email?.provider) || DEFAULT_EMAIL_PROVIDER;

  return {
    type,
    relay_http: {
      base_url: normalizedString(source?.relay_http?.base_url) || (type === "relay_http" ? legacyBaseUrl : null)
    },
    email: {
      provider,
      mode: "shared_mailbox",
      sender: normalizedString(source?.email?.sender),
      receiver: normalizedString(source?.email?.receiver),
      poll_interval_ms: normalizePollInterval(source?.email?.poll_interval_ms || defaults.email.poll_interval_ms),
      emailengine: {
        base_url: normalizedString(source?.email?.emailengine?.base_url),
        account: normalizedString(source?.email?.emailengine?.account)
      },
      gmail: {
        client_id: normalizedString(source?.email?.gmail?.client_id),
        user: normalizedString(source?.email?.gmail?.user)
      }
    }
  };
}

export function readTransportSecretsFromEnv(env = {}) {
  return {
    emailengine: {
      access_token:
        normalizedString(env[TRANSPORT_SECRET_ENV_KEYS.emailengine.access_token]) ||
        normalizedString(env[OPS_SECRET_KEYS.transport_emailengine_access_token])
    },
    gmail: {
      client_secret:
        normalizedString(env[TRANSPORT_SECRET_ENV_KEYS.gmail.client_secret]) ||
        normalizedString(env[OPS_SECRET_KEYS.transport_gmail_client_secret]),
      refresh_token:
        normalizedString(env[TRANSPORT_SECRET_ENV_KEYS.gmail.refresh_token]) ||
        normalizedString(env[OPS_SECRET_KEYS.transport_gmail_refresh_token])
    }
  };
}

export function redactTransportConfig(config = {}, env = {}) {
  const transport = normalizeTransportConfig({ runtime: { transport: config } }, env);
  const secrets = readTransportSecretsFromEnv(env);
  return {
    ...transport,
    email: {
      ...transport.email,
      emailengine: {
        ...transport.email.emailengine,
        access_token_configured: Boolean(secrets.emailengine.access_token)
      },
      gmail: {
        ...transport.email.gmail,
        client_secret_configured: Boolean(secrets.gmail.client_secret),
        refresh_token_configured: Boolean(secrets.gmail.refresh_token)
      }
    }
  };
}

export function buildTransportEnvUpdates(transportConfig = {}, env = {}) {
  const transport = normalizeTransportConfig({ runtime: { transport: transportConfig } }, env);
  const updates = {
    TRANSPORT_TYPE: transport.type,
    TRANSPORT_PROVIDER: transport.type === "email" ? transport.email.provider : null,
    TRANSPORT_BASE_URL:
      transport.type === "relay_http"
        ? transport.relay_http.base_url
        : env.TRANSPORT_BASE_URL || null,
    TRANSPORT_EMAIL_PROVIDER: transport.type === "email" ? transport.email.provider : env.TRANSPORT_EMAIL_PROVIDER || null,
    TRANSPORT_EMAIL_MODE: transport.type === "email" ? transport.email.mode : env.TRANSPORT_EMAIL_MODE || null,
    TRANSPORT_EMAIL_SENDER: transport.type === "email" ? transport.email.sender : env.TRANSPORT_EMAIL_SENDER || null,
    TRANSPORT_EMAIL_RECEIVER: transport.type === "email" ? transport.email.receiver : env.TRANSPORT_EMAIL_RECEIVER || null,
    TRANSPORT_EMAIL_POLL_INTERVAL_MS:
      transport.type === "email" ? String(transport.email.poll_interval_ms) : env.TRANSPORT_EMAIL_POLL_INTERVAL_MS || null,
    TRANSPORT_EMAILENGINE_BASE_URL:
      transport.type === "email" && transport.email.provider === "emailengine"
        ? transport.email.emailengine.base_url
        : env.TRANSPORT_EMAILENGINE_BASE_URL || null,
    TRANSPORT_EMAILENGINE_ACCOUNT:
      transport.type === "email" && transport.email.provider === "emailengine"
        ? transport.email.emailengine.account
        : env.TRANSPORT_EMAILENGINE_ACCOUNT || null,
    TRANSPORT_GMAIL_CLIENT_ID:
      transport.type === "email" && transport.email.provider === "gmail"
        ? transport.email.gmail.client_id
        : env.TRANSPORT_GMAIL_CLIENT_ID || null,
    TRANSPORT_GMAIL_USER:
      transport.type === "email" && transport.email.provider === "gmail"
        ? transport.email.gmail.user
        : env.TRANSPORT_GMAIL_USER || null
  };

  return updates;
}

export function buildTransportSecretEnvUpdates(transportConfig = {}, body = {}, currentEnv = {}) {
  const transport = normalizeTransportConfig({ runtime: { transport: transportConfig } }, currentEnv);
  const updates = {};

  const emailengineSecret = normalizedString(body?.email?.emailengine?.access_token);
  if (emailengineSecret) {
    updates[TRANSPORT_SECRET_ENV_KEYS.emailengine.access_token] = emailengineSecret;
  }

  const gmailClientSecret = normalizedString(body?.email?.gmail?.client_secret);
  if (gmailClientSecret) {
    updates[TRANSPORT_SECRET_ENV_KEYS.gmail.client_secret] = gmailClientSecret;
  }

  const gmailRefreshToken = normalizedString(body?.email?.gmail?.refresh_token);
  if (gmailRefreshToken) {
    updates[TRANSPORT_SECRET_ENV_KEYS.gmail.refresh_token] = gmailRefreshToken;
  }

  if (transport.type !== "email" || transport.email.provider !== "emailengine") {
    const current = normalizedString(currentEnv[TRANSPORT_SECRET_ENV_KEYS.emailengine.access_token]);
    if (current) {
      updates[TRANSPORT_SECRET_ENV_KEYS.emailengine.access_token] = current;
    }
  }
  if (transport.type !== "email" || transport.email.provider !== "gmail") {
    const currentClientSecret = normalizedString(currentEnv[TRANSPORT_SECRET_ENV_KEYS.gmail.client_secret]);
    const currentRefreshToken = normalizedString(currentEnv[TRANSPORT_SECRET_ENV_KEYS.gmail.refresh_token]);
    if (currentClientSecret) {
      updates[TRANSPORT_SECRET_ENV_KEYS.gmail.client_secret] = currentClientSecret;
    }
    if (currentRefreshToken) {
      updates[TRANSPORT_SECRET_ENV_KEYS.gmail.refresh_token] = currentRefreshToken;
    }
  }

  return updates;
}

export function buildTransportSecretUpdates(body = {}) {
  const updates = {};
  const emailengineSecret = normalizedString(body?.email?.emailengine?.access_token);
  if (emailengineSecret) {
    updates[OPS_SECRET_KEYS.transport_emailengine_access_token] = emailengineSecret;
  }
  const gmailClientSecret = normalizedString(body?.email?.gmail?.client_secret);
  if (gmailClientSecret) {
    updates[OPS_SECRET_KEYS.transport_gmail_client_secret] = gmailClientSecret;
  }
  const gmailRefreshToken = normalizedString(body?.email?.gmail?.refresh_token);
  if (gmailRefreshToken) {
    updates[OPS_SECRET_KEYS.transport_gmail_refresh_token] = gmailRefreshToken;
  }
  return updates;
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
    platform_console: {
      base_url: resolvedEnv.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080"
    },
    buyer: {
      enabled: true,
      api_key: null,
      api_key_configured: Boolean(resolvedEnv.BUYER_PLATFORM_API_KEY || resolvedEnv.PLATFORM_API_KEY),
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
      external_relay: null,
      transport: defaultTransportConfig()
    }
  };
}

export function ensureOpsState() {
  ensureOpsDirectories();
  const envFile = getOpsEnvFile();
  const env = readEnvFile(envFile);
  const secretsFile = getOpsSecretsFile();
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
  config.platform_console ||= { base_url: config.platform.base_url || env.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080" };
  config.buyer ||= {
    enabled: true,
    api_key: null,
    api_key_configured: false,
    contact_email: env.BUYER_CONTACT_EMAIL || process.env.BUYER_CONTACT_EMAIL || null
  };
  const buyerApiKey =
    config.buyer.api_key ||
    env.BUYER_PLATFORM_API_KEY ||
    env.PLATFORM_API_KEY ||
    process.env.BUYER_PLATFORM_API_KEY ||
    process.env.PLATFORM_API_KEY ||
    null;
  config.buyer.api_key = normalizedString(config.buyer.api_key);
  config.buyer.api_key_configured = Boolean(buyerApiKey);
  config.seller ||= {
    enabled: false,
    seller_id: env.SELLER_ID || process.env.SELLER_ID || null,
    display_name: "Local Seller",
    subagents: []
  };
  const defaultPorts = resolveDefaultPorts();
  config.runtime ||= { ports: defaultPorts, external_relay: null, transport: defaultTransportConfig() };
  config.runtime.ports ||= defaultPorts;
  config.runtime.transport = normalizeTransportConfig(config, env);

  for (const [key, value] of Object.entries(defaultPorts)) {
    config.runtime.ports[key] ||= value;
  }

  return { envFile, opsConfigFile, secretsFile, env, config };
}

function getLegacyConfigSecret(config, secretKey) {
  const pathSegments = LEGACY_SECRET_CONFIG_PATHS[secretKey];
  if (!pathSegments) {
    return null;
  }
  let current = config;
  for (const segment of pathSegments) {
    current = current?.[segment];
  }
  return normalizedString(current);
}

export function readLegacyOpsSecrets(state) {
  const env = state?.env || {};
  const config = state?.config || {};
  const transport = readTransportSecretsFromEnv(env);
  return {
    [OPS_SECRET_KEYS.buyer_api_key]:
      getLegacyConfigSecret(config, OPS_SECRET_KEYS.buyer_api_key) ||
      normalizedString(env.BUYER_PLATFORM_API_KEY) ||
      normalizedString(env.PLATFORM_API_KEY),
    [OPS_SECRET_KEYS.seller_platform_api_key]: normalizedString(env.SELLER_PLATFORM_API_KEY),
    [OPS_SECRET_KEYS.transport_emailengine_access_token]: transport.emailengine.access_token,
    [OPS_SECRET_KEYS.transport_gmail_client_secret]: transport.gmail.client_secret,
    [OPS_SECRET_KEYS.transport_gmail_refresh_token]: transport.gmail.refresh_token,
    [OPS_SECRET_KEYS.platform_admin_api_key]:
      getLegacyConfigSecret(config, OPS_SECRET_KEYS.platform_admin_api_key) ||
      normalizedString(env.PLATFORM_ADMIN_API_KEY)
  };
}

export function listLegacySecretKeys(state) {
  return Object.entries(readLegacyOpsSecrets(state))
    .filter(([, value]) => normalizedString(value))
    .map(([key]) => key);
}

export function getConfiguredSecretFile() {
  return getOpsSecretsFile();
}

export function hasEncryptedSecretStore() {
  return secretStoreExists(getConfiguredSecretFile());
}

export function unlockOpsSecrets(passphrase) {
  return unlockSecretStore(getConfiguredSecretFile(), passphrase).secrets;
}

export function writeOpsSecrets(passphrase, updates) {
  return writeSecretValues(getConfiguredSecretFile(), passphrase, updates);
}

export function readResolvedOpsSecrets(state, unlockedSecrets = null) {
  const legacy = readLegacyOpsSecrets(state);
  const encrypted = unlockedSecrets || {};
  return {
    buyer_api_key: normalizedString(encrypted[OPS_SECRET_KEYS.buyer_api_key]) || legacy[OPS_SECRET_KEYS.buyer_api_key] || null,
    seller_platform_api_key:
      normalizedString(encrypted[OPS_SECRET_KEYS.seller_platform_api_key]) || legacy[OPS_SECRET_KEYS.seller_platform_api_key] || null,
    transport: {
      emailengine: {
        access_token:
          normalizedString(encrypted[OPS_SECRET_KEYS.transport_emailengine_access_token]) ||
          legacy[OPS_SECRET_KEYS.transport_emailengine_access_token] ||
          null
      },
      gmail: {
        client_secret:
          normalizedString(encrypted[OPS_SECRET_KEYS.transport_gmail_client_secret]) ||
          legacy[OPS_SECRET_KEYS.transport_gmail_client_secret] ||
          null,
        refresh_token:
          normalizedString(encrypted[OPS_SECRET_KEYS.transport_gmail_refresh_token]) ||
          legacy[OPS_SECRET_KEYS.transport_gmail_refresh_token] ||
          null
      }
    },
    platform_admin_api_key:
      normalizedString(encrypted[OPS_SECRET_KEYS.platform_admin_api_key]) || legacy[OPS_SECRET_KEYS.platform_admin_api_key] || null
  };
}

export function scrubLegacySecrets(state) {
  if (!state?.config || !state?.envFile) {
    return state;
  }
  if (state.config.buyer) {
    state.config.buyer.api_key = null;
    state.config.buyer.api_key_configured = true;
  }
  state.config.platform_console ||= {};
  state.config.platform_console.admin_api_key = null;
  writeJsonFile(state.opsConfigFile, state.config);
  state.env = updateEnvFile(
    state.envFile,
    {
      BUYER_PLATFORM_API_KEY: null,
      PLATFORM_API_KEY: null,
      SELLER_PLATFORM_API_KEY: null,
      PLATFORM_ADMIN_API_KEY: null,
      TRANSPORT_EMAILENGINE_ACCESS_TOKEN: null,
      TRANSPORT_GMAIL_CLIENT_SECRET: null,
      TRANSPORT_GMAIL_REFRESH_TOKEN: null
    },
    { removeNull: true }
  );
  return state;
}

export function saveOpsState({ envFile, opsConfigFile, env, config }) {
  const encryptedStoreConfigured = secretStoreExists(getConfiguredSecretFile());
  const resolvedBuyerApiKey =
    normalizedString(env.BUYER_PLATFORM_API_KEY) ||
    normalizedString(env.PLATFORM_API_KEY) ||
    normalizedString(config.buyer?.api_key);
  const resolvedSellerPlatformApiKey = normalizedString(env.SELLER_PLATFORM_API_KEY);
  const resolvedPlatformAdminApiKey =
    normalizedString(env.PLATFORM_ADMIN_API_KEY) ||
    normalizedString(config.platform_console?.admin_api_key);
  const transportSecrets = readTransportSecretsFromEnv(env);

  config.buyer ||= {};
  config.buyer.api_key = null;
  config.buyer.api_key_configured = Boolean(config.buyer.api_key_configured || resolvedBuyerApiKey);
  config.platform_console ||= {};
  config.platform_console.admin_api_key = null;
  writeJsonFile(opsConfigFile, config);
  const transportEnv = buildTransportEnvUpdates(config.runtime?.transport || {}, env);
  const relayBaseUrl =
    normalizeTransportConfig(config, env).type === "local"
      ? `http://127.0.0.1:${config.runtime?.ports?.relay || DEFAULT_PORTS.relay}`
      : transportEnv.TRANSPORT_BASE_URL;
  const updates = {
    PLATFORM_API_BASE_URL: config.platform?.base_url || env.PLATFORM_API_BASE_URL || null,
    BUYER_PLATFORM_API_KEY: encryptedStoreConfigured ? null : resolvedBuyerApiKey,
    PLATFORM_API_KEY: encryptedStoreConfigured ? null : resolvedBuyerApiKey,
    BUYER_CONTACT_EMAIL: config.buyer?.contact_email || env.BUYER_CONTACT_EMAIL || null,
    SELLER_PLATFORM_API_KEY: encryptedStoreConfigured ? null : resolvedSellerPlatformApiKey,
    SELLER_ID: config.seller?.seller_id || env.SELLER_ID || null,
    SUBAGENT_IDS: (config.seller?.subagents || []).map((item) => item.subagent_id).filter(Boolean).join(","),
    TRANSPORT_BASE_URL: relayBaseUrl,
    TRANSPORT_TYPE: transportEnv.TRANSPORT_TYPE,
    TRANSPORT_PROVIDER: transportEnv.TRANSPORT_PROVIDER,
    TRANSPORT_EMAIL_PROVIDER: transportEnv.TRANSPORT_EMAIL_PROVIDER,
    TRANSPORT_EMAIL_MODE: transportEnv.TRANSPORT_EMAIL_MODE,
    TRANSPORT_EMAIL_SENDER: transportEnv.TRANSPORT_EMAIL_SENDER,
    TRANSPORT_EMAIL_RECEIVER: transportEnv.TRANSPORT_EMAIL_RECEIVER,
    TRANSPORT_EMAIL_POLL_INTERVAL_MS: transportEnv.TRANSPORT_EMAIL_POLL_INTERVAL_MS,
    TRANSPORT_EMAILENGINE_BASE_URL: transportEnv.TRANSPORT_EMAILENGINE_BASE_URL,
    TRANSPORT_EMAILENGINE_ACCOUNT: transportEnv.TRANSPORT_EMAILENGINE_ACCOUNT,
    TRANSPORT_GMAIL_CLIENT_ID: transportEnv.TRANSPORT_GMAIL_CLIENT_ID,
    TRANSPORT_GMAIL_USER: transportEnv.TRANSPORT_GMAIL_USER,
    TRANSPORT_EMAILENGINE_ACCESS_TOKEN: encryptedStoreConfigured ? null : transportSecrets.emailengine.access_token,
    TRANSPORT_GMAIL_CLIENT_SECRET: encryptedStoreConfigured ? null : transportSecrets.gmail.client_secret,
    TRANSPORT_GMAIL_REFRESH_TOKEN: encryptedStoreConfigured ? null : transportSecrets.gmail.refresh_token,
    PLATFORM_ADMIN_API_KEY: encryptedStoreConfigured ? null : resolvedPlatformAdminApiKey,
    PORT: null
  };
  return updateEnvFile(envFile, updates, { removeNull: true });
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
