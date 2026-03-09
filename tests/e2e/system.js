import { createBuyerControllerServer } from "@croc/buyer-controller";
import { createPlatformServer, createPlatformState } from "@croc/platform-api";
import { createSellerControllerServer, createSellerState } from "@croc/seller-controller";
import { createLocalTransportAdapter, createLocalTransportHub } from "@croc/transport-local";
import { closeServer, listenServer } from "../helpers/http.js";

export async function startSystem() {
  const platformState = createPlatformState();
  const hub = createLocalTransportHub();
  const bootstrapSeller = platformState.bootstrap.sellers[0];
  const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
  const sellerTransport = createLocalTransportAdapter({ hub, receiver: bootstrapSeller.seller_id });

  const platformServer = createPlatformServer({ serviceName: "platform-api-e2e", state: platformState });
  const platformUrl = await listenServer(platformServer);
  const buyerServer = createBuyerControllerServer({
    serviceName: "buyer-controller-e2e",
    transport: buyerTransport,
    platform: {
      baseUrl: platformUrl
    },
    config: {
      timeout_confirmation_mode: "ask_by_default",
      hard_timeout_auto_finalize: true,
      poll_interval_active_s: 1,
      poll_interval_backoff_s: 1
    },
    background: {
      enabled: true,
      inboxPollIntervalMs: 25,
      eventsSyncIntervalMs: 25
    }
  });
  const sellerServer = createSellerControllerServer({
    serviceName: "seller-controller-e2e",
    transport: sellerTransport,
    platform: {
      baseUrl: platformUrl,
      apiKey: bootstrapSeller.api_key,
      sellerId: bootstrapSeller.seller_id
    },
    state: createSellerState({
      sellerId: bootstrapSeller.seller_id,
      subagentIds: [bootstrapSeller.subagent_id],
      signing: bootstrapSeller.signing
    }),
    background: {
      enabled: true,
      inboxPollIntervalMs: 25
    }
  });
  const buyerUrl = await listenServer(buyerServer);
  const sellerUrl = await listenServer(sellerServer);

  return {
    platformServer,
    buyerServer,
    sellerServer,
    platformUrl,
    buyerUrl,
    sellerUrl,
    platformState,
    bootstrapSeller
  };
}

export async function stopSystem(system) {
  await closeServer(system.platformServer);
  await closeServer(system.buyerServer);
  await closeServer(system.sellerServer);
}
