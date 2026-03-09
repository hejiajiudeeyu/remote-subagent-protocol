import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBuyerControllerServer, createBuyerState, hydrateBuyerState, serializeBuyerState } from "@croc/buyer-controller-core";
import { createPostgresSnapshotStore } from "@croc/postgres-store";
import { createSqliteSnapshotStore } from "@croc/sqlite-store";
import { createRelayHttpTransportAdapter } from "@croc/transport-relay-http";
import { buildOpsEnvSearchPaths, loadEnvFiles } from "../../../scripts/env-files.mjs";

export * from "@croc/buyer-controller-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../..");

loadEnvFiles(buildOpsEnvSearchPaths(ROOT_DIR, "buyer"));

function isDirectRun() {
  if (!process.argv[1]) {
    return false;
  }
  return path.resolve(process.argv[1]) === __filename;
}

function loadPlatformConfigFromEnv() {
  const baseUrl = process.env.PLATFORM_API_BASE_URL || null;
  if (!baseUrl) {
    return null;
  }

  return {
    baseUrl,
    apiKey: process.env.BUYER_PLATFORM_API_KEY || process.env.PLATFORM_API_KEY || null
  };
}

function loadTransportConfigFromEnv(serviceName) {
  const baseUrl = process.env.TRANSPORT_BASE_URL || null;
  if (!baseUrl) {
    return null;
  }

  return createRelayHttpTransportAdapter({
    baseUrl,
    receiver: process.env.TRANSPORT_RECEIVER || serviceName
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
  const port = Number(process.env.PORT || 8081);
  const serviceName = process.env.SERVICE_NAME || "buyer-controller";
  const state = createBuyerState();
  const transport = loadTransportConfigFromEnv(serviceName);
  const persistence = await createOptionalPersistence(serviceName);
  if (persistence) {
    hydrateBuyerState(state, await persistence.loadSnapshot());
  }
  const server = createBuyerControllerServer({
    serviceName,
    state,
    transport,
    platform: loadPlatformConfigFromEnv(),
    background: {
      enabled: Boolean(transport),
      receiver: process.env.TRANSPORT_RECEIVER || serviceName,
      inboxPollIntervalMs: Number(process.env.BUYER_CONTROLLER_INBOX_POLL_INTERVAL_MS || 250),
      eventsSyncIntervalMs: Number(process.env.BUYER_CONTROLLER_EVENTS_SYNC_INTERVAL_MS || 250)
    },
    onStateChanged: persistence
      ? async (currentState) => {
          await persistence.saveSnapshot(serializeBuyerState(currentState));
        }
      : null
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[${serviceName}] listening on ${port}`);
  });
  server.on("close", () => {
    if (persistence) {
      void persistence.saveSnapshot(serializeBuyerState(state));
      void persistence.close();
    }
  });
}
