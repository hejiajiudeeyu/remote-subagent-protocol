import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSubagentRouterExecutor,
  createSellerControllerServer,
  createSellerState,
  hydrateSellerState,
  serializeSellerState,
  startSellerHeartbeatLoop
} from "@delexec/seller-runtime-core";
import { createPostgresSnapshotStore } from "@delexec/postgres-store";
import { createSqliteSnapshotStore } from "@delexec/sqlite-store";
import { createEmailEngineTransportAdapter } from "@delexec/transport-emailengine";
import { createGmailTransportAdapter } from "@delexec/transport-gmail";
import { createRelayHttpTransportAdapter } from "@delexec/transport-relay-http";
import { buildOpsEnvSearchPaths, getOpsConfigFile, getSellerConfigFile, loadEnvFiles, readJsonFile } from "@delexec/runtime-utils";

export * from "@delexec/seller-runtime-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");

loadEnvFiles(buildOpsEnvSearchPaths(ROOT_DIR, "seller"));

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return fs.realpathSync.native(path.resolve(process.argv[1])) === fs.realpathSync.native(__filename);
}

function decodePemEnv(value) {
  if (!value) {
    return null;
  }
  return value.replace(/\\n/g, "\n");
}

function loadSellerStateFromEnv() {
  const sellerId = process.env.SELLER_ID || null;
  const subagentIds = (process.env.SUBAGENT_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const publicKeyPem = decodePemEnv(process.env.SELLER_SIGNING_PUBLIC_KEY_PEM);
  const privateKeyPem = decodePemEnv(process.env.SELLER_SIGNING_PRIVATE_KEY_PEM);

  if (!sellerId && subagentIds.length === 0 && !publicKeyPem && !privateKeyPem) {
    return createSellerState();
  }

  const stateOptions = {};
  if (sellerId) {
    stateOptions.sellerId = sellerId;
  }
  if (subagentIds.length > 0) {
    stateOptions.subagentIds = subagentIds;
  }
  if (publicKeyPem || privateKeyPem) {
    if (!publicKeyPem || !privateKeyPem) {
      throw new Error("seller_signing_key_pair_incomplete");
    }
    stateOptions.signing = {
      publicKeyPem,
      privateKeyPem
    };
  }

  return createSellerState(stateOptions);
}

function loadSellerConfigFromDisk() {
  const opsConfig = readJsonFile(getOpsConfigFile(), null);
  if (opsConfig?.seller) {
    return {
      seller_id: opsConfig.seller.seller_id || null,
      display_name: opsConfig.seller.display_name || null,
      enabled: opsConfig.seller.enabled !== false,
      subagents: Array.isArray(opsConfig.seller.subagents) ? opsConfig.seller.subagents : []
    };
  }
  return readJsonFile(getSellerConfigFile(), { seller_id: null, display_name: null, enabled: true, subagents: [] });
}

function mergeConfigSubagentsIntoState(state, config) {
  const configuredIds = Array.isArray(config?.subagents)
    ? config.subagents.map((item) => item?.subagent_id).filter(Boolean)
    : [];
  if (configuredIds.length === 0) {
    return state;
  }
  const merged = new Set([...(state.identity.subagent_ids || []), ...configuredIds]);
  state.identity.subagent_ids = Array.from(merged);
  if (!state.identity.seller_id && config?.seller_id) {
    state.identity.seller_id = config.seller_id;
  }
  state.subagents = Array.isArray(config?.subagents) ? config.subagents : [];
  return state;
}

function createExecutorFromConfig(config) {
  const subagents = Array.isArray(config?.subagents) ? config.subagents : [];
  if (subagents.length === 0) {
    return null;
  }
  return createSubagentRouterExecutor(subagents);
}

function loadPlatformConfigFromEnv() {
  const baseUrl = process.env.PLATFORM_API_BASE_URL || null;
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl,
    apiKey: process.env.SELLER_PLATFORM_API_KEY || process.env.PLATFORM_API_KEY || null,
    sellerId: process.env.SELLER_ID || null
  };
}

function loadSellerGuardrailsFromEnv() {
  const allowedTaskTypes = (process.env.SELLER_ALLOWED_TASK_TYPES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const maxHardTimeoutS = process.env.SELLER_MAX_HARD_TIMEOUT_S || null;

  return {
    maxHardTimeoutS: maxHardTimeoutS ? Number(maxHardTimeoutS) : null,
    allowedTaskTypes: allowedTaskTypes.length > 0 ? allowedTaskTypes : null
  };
}

function loadTransportConfigFromEnv() {
  const transportType = process.env.TRANSPORT_TYPE || (process.env.TRANSPORT_BASE_URL ? "relay_http" : null);
  if (transportType === "email") {
    const provider = process.env.TRANSPORT_EMAIL_PROVIDER || process.env.TRANSPORT_PROVIDER || "unknown";
    if (provider === "emailengine") {
      return createEmailEngineTransportAdapter({
        baseUrl: process.env.TRANSPORT_EMAILENGINE_BASE_URL,
        account: process.env.TRANSPORT_EMAILENGINE_ACCOUNT,
        accessToken: process.env.TRANSPORT_EMAILENGINE_ACCESS_TOKEN,
        sender: process.env.TRANSPORT_EMAIL_SENDER || process.env.TRANSPORT_EMAILENGINE_ACCOUNT || null,
        receiver: process.env.TRANSPORT_EMAIL_RECEIVER || process.env.SELLER_ID || null
      });
    }
    if (provider === "gmail") {
      return createGmailTransportAdapter({
        clientId: process.env.TRANSPORT_GMAIL_CLIENT_ID,
        clientSecret: process.env.TRANSPORT_GMAIL_CLIENT_SECRET,
        refreshToken: process.env.TRANSPORT_GMAIL_REFRESH_TOKEN,
        user: process.env.TRANSPORT_GMAIL_USER,
        sender: process.env.TRANSPORT_EMAIL_SENDER || process.env.TRANSPORT_GMAIL_USER || null,
        receiver: process.env.TRANSPORT_EMAIL_RECEIVER || process.env.SELLER_ID || null
      });
    }
    throw new Error(`TRANSPORT_NOT_IMPLEMENTED: email transport provider ${provider} is not implemented yet`);
  }
  const baseUrl = process.env.TRANSPORT_BASE_URL || null;
  if (!baseUrl || !transportType) {
    return null;
  }

  return createRelayHttpTransportAdapter({
    baseUrl,
    receiver: process.env.TRANSPORT_RECEIVER || process.env.SELLER_ID || "seller-controller"
  });
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
  const port = Number(process.env.PORT || 8082);
  const serviceName = process.env.SERVICE_NAME || "seller-controller";
  const sellerConfig = loadSellerConfigFromDisk();
  const state = mergeConfigSubagentsIntoState(loadSellerStateFromEnv(), sellerConfig);
  const platform = loadPlatformConfigFromEnv();
  const transport = loadTransportConfigFromEnv();
  const executor = createExecutorFromConfig(sellerConfig);
  const persistence = await createOptionalPersistence(serviceName);
  if (persistence) {
    hydrateSellerState(state, await persistence.loadSnapshot());
  }
  let stopHeartbeat = () => {};
  const persistSnapshot = persistence
    ? async (currentState) => {
        await persistence.saveSnapshot(serializeSellerState(currentState));
      }
    : null;

  function restartHeartbeatLoop() {
    stopHeartbeat();
    if (platform?.baseUrl && platform?.apiKey) {
      stopHeartbeat = startSellerHeartbeatLoop({
        state,
        platform,
        intervalMs: Number(process.env.SELLER_HEARTBEAT_INTERVAL_MS || 30000),
        onStateChanged: persistSnapshot
      });
      return;
    }
    stopHeartbeat = () => {};
  }

  const server = createSellerControllerServer({
    serviceName,
    state,
    transport,
    platform,
    ...(executor ? { executor } : {}),
    guardrails: loadSellerGuardrailsFromEnv(),
    background: {
      enabled: Boolean(transport),
      receiver: process.env.TRANSPORT_RECEIVER || state.identity.seller_id,
      inboxPollIntervalMs: Number(process.env.SELLER_INBOX_POLL_INTERVAL_MS || 250),
      workerConcurrency: Number(process.env.SELLER_WORKER_CONCURRENCY || state.workerConcurrency || 1)
    },
    onStateChanged: persistSnapshot,
    onPlatformConfigured: async () => {
      restartHeartbeatLoop();
      if (persistSnapshot) {
        await persistSnapshot(state);
      }
    }
  });

  server.listen(port, "0.0.0.0", () => {
    restartHeartbeatLoop();
    console.log(`[${serviceName}] listening on ${port}`);
  });

  server.on("close", () => {
    stopHeartbeat();
    if (persistence) {
      void persistence.saveSnapshot(serializeSellerState(state));
      void persistence.close();
    }
  });
}
