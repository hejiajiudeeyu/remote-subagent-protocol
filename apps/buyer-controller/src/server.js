import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createBuyerControllerServer,
  createBuyerState,
  hydrateBuyerState,
  serializeBuyerState
} from "../../../packages/buyer-controller-core/src/index.js";
import { createPostgresSnapshotStore } from "../../../packages/postgres-store/src/index.js";
import { createSqliteSnapshotStore } from "../../../packages/sqlite-store/src/index.js";

export * from "../../../packages/buyer-controller-core/src/index.js";

const __filename = fileURLToPath(import.meta.url);

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
    apiKey: process.env.PLATFORM_API_KEY || null
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
  const port = Number(process.env.PORT || 8081);
  const serviceName = process.env.SERVICE_NAME || "buyer-controller";
  const state = createBuyerState();
  const persistence = await createOptionalPersistence(serviceName);
  if (persistence) {
    hydrateBuyerState(state, await persistence.loadSnapshot());
  }
  const server = createBuyerControllerServer({
    serviceName,
    state,
    platform: loadPlatformConfigFromEnv(),
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
