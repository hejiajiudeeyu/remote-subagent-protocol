import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSellerControllerServer,
  createSellerState,
  hydrateSellerState,
  serializeSellerState,
  startSellerHeartbeatLoop
} from "../../../packages/seller-runtime-core/src/index.js";
import { createPostgresSnapshotStore } from "../../../packages/postgres-store/src/index.js";
import { createSqliteSnapshotStore } from "../../../packages/sqlite-store/src/index.js";

export * from "../../../packages/seller-runtime-core/src/index.js";

const __filename = fileURLToPath(import.meta.url);

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === __filename;
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

function loadPlatformConfigFromEnv() {
  const baseUrl = process.env.PLATFORM_API_BASE_URL || null;
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl,
    apiKey: process.env.PLATFORM_API_KEY || null,
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
  const state = loadSellerStateFromEnv();
  const platform = loadPlatformConfigFromEnv();
  const persistence = await createOptionalPersistence(serviceName);
  if (persistence) {
    hydrateSellerState(state, await persistence.loadSnapshot());
  }
  const server = createSellerControllerServer({
    serviceName,
    state,
    platform,
    guardrails: loadSellerGuardrailsFromEnv(),
    onStateChanged: persistence
      ? async (currentState) => {
          await persistence.saveSnapshot(serializeSellerState(currentState));
        }
      : null
  });
  let stopHeartbeat = () => {};

  server.listen(port, "0.0.0.0", () => {
    const heartbeatIntervalMs = Number(process.env.SELLER_HEARTBEAT_INTERVAL_MS || 30000);
    if (platform?.baseUrl && platform?.apiKey) {
      stopHeartbeat = startSellerHeartbeatLoop({
        state,
        platform,
        intervalMs: heartbeatIntervalMs,
        onStateChanged: persistence
          ? async (currentState) => {
              await persistence.saveSnapshot(serializeSellerState(currentState));
            }
          : null
      });
    }
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
