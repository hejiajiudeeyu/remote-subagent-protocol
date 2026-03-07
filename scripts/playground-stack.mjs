import process from "node:process";

import {
  createPlatformServer,
  createPlatformState,
  hydratePlatformState,
  serializePlatformState
} from "../apps/platform-api/src/server.js";
import {
  createBuyerControllerServer,
  createBuyerState,
  hydrateBuyerState,
  serializeBuyerState
} from "../packages/buyer-controller-core/src/index.js";
import {
  createSellerControllerServer,
  createSellerState,
  hydrateSellerState,
  serializeSellerState,
  startSellerHeartbeatLoop
} from "../packages/seller-runtime-core/src/index.js";
import { createPostgresSnapshotStore } from "../packages/postgres-store/src/index.js";
import { createSqliteSnapshotStore } from "../packages/sqlite-store/src/index.js";
import { createLocalTransportAdapter, createLocalTransportHub } from "../packages/transports/local/src/index.js";

function decodePemEnv(value) {
  if (!value) {
    return null;
  }
  return value.replace(/\\n/g, "\n");
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

function createSellerStateFromEnv() {
  const sellerId = process.env.SELLER_ID || process.env.BOOTSTRAP_SELLER_ID || "seller_foxlab";
  const subagentIds = (process.env.SUBAGENT_IDS || process.env.BOOTSTRAP_SUBAGENT_ID || "foxlab.text.classifier.v1")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const publicKeyPem = decodePemEnv(process.env.SELLER_SIGNING_PUBLIC_KEY_PEM || process.env.BOOTSTRAP_SELLER_PUBLIC_KEY_PEM);
  const privateKeyPem = decodePemEnv(
    process.env.SELLER_SIGNING_PRIVATE_KEY_PEM || process.env.BOOTSTRAP_SELLER_PRIVATE_KEY_PEM
  );

  return createSellerState({
    sellerId,
    subagentIds,
    signing:
      publicKeyPem && privateKeyPem
        ? {
            publicKeyPem,
            privateKeyPem
          }
        : undefined
  });
}

function resolveBootstrapSeller(platformState, requestedSellerId) {
  const bootstrapSellers = platformState?.bootstrap?.sellers || [];
  if (!Array.isArray(bootstrapSellers) || bootstrapSellers.length === 0) {
    return null;
  }
  if (!requestedSellerId) {
    return bootstrapSellers[0];
  }
  return bootstrapSellers.find((item) => item.seller_id === requestedSellerId) || bootstrapSellers[0];
}

async function main() {
  const platformPersistence = await createOptionalPersistence("platform-api");
  const buyerPersistence = await createOptionalPersistence("buyer-controller");
  const sellerPersistence = await createOptionalPersistence("seller-controller");

  const platformState = createPlatformState();
  if (platformPersistence) {
    hydratePlatformState(platformState, await platformPersistence.loadSnapshot());
  }

  const requestedSellerId = process.env.SELLER_ID || process.env.BOOTSTRAP_SELLER_ID || "seller_foxlab";
  const bootstrapSeller = resolveBootstrapSeller(platformState, requestedSellerId);

  const buyerState = createBuyerState();
  if (buyerPersistence) {
    hydrateBuyerState(buyerState, await buyerPersistence.loadSnapshot());
  }

  const sellerState =
    process.env.SELLER_SIGNING_PUBLIC_KEY_PEM || process.env.SELLER_SIGNING_PRIVATE_KEY_PEM
      ? createSellerStateFromEnv()
      : createSellerState({
          sellerId: bootstrapSeller?.seller_id || requestedSellerId,
          subagentIds: [bootstrapSeller?.subagent_id || process.env.BOOTSTRAP_SUBAGENT_ID || "foxlab.text.classifier.v1"],
          signing: bootstrapSeller?.signing
            ? {
                publicKeyPem: bootstrapSeller.signing.publicKeyPem,
                privateKeyPem: bootstrapSeller.signing.privateKeyPem
              }
            : undefined
        });
  if (sellerPersistence) {
    hydrateSellerState(sellerState, await sellerPersistence.loadSnapshot());
  }

  const hub = createLocalTransportHub();
  const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
  const sellerTransport = createLocalTransportAdapter({
    hub,
    receiver: sellerState.identity.seller_id
  });

  const platformBaseUrl = process.env.PLATFORM_API_BASE_URL || "http://127.0.0.1:8080";
  const sellerApiKey = process.env.PLATFORM_API_KEY || process.env.BOOTSTRAP_SELLER_API_KEY || bootstrapSeller?.api_key || null;
  const sellerGuardrails = {
    maxHardTimeoutS: Number(process.env.SELLER_MAX_HARD_TIMEOUT_S || 300),
    allowedTaskTypes: (process.env.SELLER_ALLOWED_TASK_TYPES || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  };

  const platformServer = createPlatformServer({
    state: platformState,
    serviceName: "platform-api",
    onStateChanged: platformPersistence
      ? async (currentState) => {
          await platformPersistence.saveSnapshot(serializePlatformState(currentState));
        }
      : null
  });

  const buyerServer = createBuyerControllerServer({
    state: buyerState,
    serviceName: "buyer-controller",
    transport: buyerTransport,
    platform: {
      baseUrl: platformBaseUrl,
      apiKey: process.env.BUYER_PLATFORM_API_KEY || null
    },
    onStateChanged: buyerPersistence
      ? async (currentState) => {
          await buyerPersistence.saveSnapshot(serializeBuyerState(currentState));
        }
      : null
  });

  const sellerServer = createSellerControllerServer({
    state: sellerState,
    serviceName: "seller-controller",
    transport: sellerTransport,
    platform: {
      baseUrl: platformBaseUrl,
      apiKey: sellerApiKey,
      sellerId: sellerState.identity.seller_id
    },
    guardrails: {
      maxHardTimeoutS: Number.isFinite(sellerGuardrails.maxHardTimeoutS) ? sellerGuardrails.maxHardTimeoutS : null,
      allowedTaskTypes: sellerGuardrails.allowedTaskTypes.length > 0 ? sellerGuardrails.allowedTaskTypes : null
    },
    onStateChanged: sellerPersistence
      ? async (currentState) => {
          await sellerPersistence.saveSnapshot(serializeSellerState(currentState));
        }
      : null
  });

  const stopHeartbeat = startSellerHeartbeatLoop({
    state: sellerState,
    platform: {
      baseUrl: platformBaseUrl,
      apiKey: sellerApiKey,
      sellerId: sellerState.identity.seller_id
    },
    intervalMs: Number(process.env.SELLER_HEARTBEAT_INTERVAL_MS || 30000),
    onStateChanged: sellerPersistence
      ? async (currentState) => {
          await sellerPersistence.saveSnapshot(serializeSellerState(currentState));
        }
      : null
  });

  const servers = [
    { name: "platform-api", server: platformServer, port: 8080 },
    { name: "buyer-controller", server: buyerServer, port: 8081 },
    { name: "seller-controller", server: sellerServer, port: 8082 }
  ];

  await Promise.all(
    servers.map(
      ({ server, port, name }) =>
        new Promise((resolve) => {
          server.listen(port, "0.0.0.0", () => {
            console.log(`[${name}] listening on ${port}`);
            resolve();
          });
        })
    )
  );

  async function shutdown() {
    stopHeartbeat();
    await Promise.all(
      servers.map(
        ({ server }) =>
          new Promise((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    await Promise.all([
      platformPersistence?.saveSnapshot(serializePlatformState(platformState)),
      buyerPersistence?.saveSnapshot(serializeBuyerState(buyerState)),
      sellerPersistence?.saveSnapshot(serializeSellerState(sellerState))
    ]);
    await Promise.all([platformPersistence?.close(), buyerPersistence?.close(), sellerPersistence?.close()]);
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[playground-stack] fatal", error);
  process.exit(1);
});
