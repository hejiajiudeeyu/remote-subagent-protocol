import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "../../apps/platform-api/src/server.js";
import { createSellerControllerServer } from "../../apps/seller-controller/src/server.js";
import { createLocalTransportAdapter, createLocalTransportHub } from "../../packages/transports/local/src/index.js";
import { closeServer, jsonRequest, listenServer, waitFor } from "../helpers/http.js";

describe("seller-controller integration", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = createSellerControllerServer({ serviceName: "seller-controller-test" });
    baseUrl = await listenServer(server);
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("queues and completes success task", async () => {
    const created = await jsonRequest(baseUrl, "/controller/tasks", {
      method: "POST",
      body: {
        request_id: "req_seller_success_1",
        simulate: "success",
        delay_ms: 30
      }
    });

    expect(created.status).toBe(202);

    const result = await waitFor(async () => {
      const polled = await jsonRequest(baseUrl, `/controller/tasks/${created.body.task_id}/result`);
      if (polled.status !== 200 || polled.body.available !== true) {
        throw new Error("result_not_ready");
      }
      return polled;
    });

    expect(result.body.result_package.status).toBe("ok");
    expect(result.body.result_package.signature_algorithm).toBe("Ed25519");
    expect(typeof result.body.result_package.signer_public_key_pem).toBe("string");
    expect(typeof result.body.result_package.signature_base64).toBe("string");
  });

  it("returns error package for token_expired simulation", async () => {
    const created = await jsonRequest(baseUrl, "/controller/tasks", {
      method: "POST",
      body: {
        request_id: "req_seller_token_expired_1",
        simulate: "token_expired",
        delay_ms: 20
      }
    });

    const result = await waitFor(async () => {
      const polled = await jsonRequest(baseUrl, `/controller/tasks/${created.body.task_id}/result`);
      if (polled.status !== 200 || polled.body.available !== true) {
        throw new Error("result_not_ready");
      }
      return polled;
    });

    expect(result.body.result_package.status).toBe("error");
    expect(result.body.result_package.error.code).toBe("AUTH_TOKEN_EXPIRED");
  });

  it("supports replay only after result is ready", async () => {
    const created = await jsonRequest(baseUrl, "/controller/tasks", {
      method: "POST",
      body: {
        request_id: "req_seller_replay_1",
        simulate: "success",
        delay_ms: 60
      }
    });

    const replayEarly = await jsonRequest(baseUrl, `/controller/tasks/${created.body.task_id}/replay`, {
      method: "POST"
    });
    expect(replayEarly.status).toBe(409);
    expect(replayEarly.body.error).toBe("RESULT_NOT_READY");

    const result = await waitFor(async () => {
      const polled = await jsonRequest(baseUrl, `/controller/tasks/${created.body.task_id}/result`);
      if (polled.status !== 200 || polled.body.available !== true) {
        throw new Error("result_not_ready");
      }
      return polled;
    });

    const replayReady = await jsonRequest(baseUrl, `/controller/tasks/${created.body.task_id}/replay`, {
      method: "POST"
    });
    expect(replayReady.status).toBe(200);
    expect(replayReady.body.replayed).toBe(true);
    expect(replayReady.body.result_package.request_id).toBe(result.body.result_package.request_id);
  });

  it("introspects inbound token, auto-acks platform, and sends result to buyer queue", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-auto-ack-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const hub = createLocalTransportHub();
    const seller = platformState.bootstrap.sellers[0];
    const transport = createLocalTransportAdapter({ hub, receiver: seller.seller_id });
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const autoSellerServer = createSellerControllerServer({
      serviceName: "seller-controller-auto-test",
      transport,
      platform: {
        baseUrl: platformUrl,
        apiKey: seller.api_key,
        sellerId: seller.seller_id
      }
    });
    const autoSellerUrl = await listenServer(autoSellerServer);

    try {
      const registered = await jsonRequest(platformUrl, "/v1/users/register", {
        method: "POST",
        body: { contact_email: "seller-auto@test.local" }
      });
      const authHeader = { Authorization: `Bearer ${registered.body.api_key}` };
      const requestId = "req_seller_auto_1";

      const issued = await jsonRequest(platformUrl, "/v1/tokens/task", {
        method: "POST",
        headers: authHeader,
        body: {
          request_id: requestId,
          seller_id: seller.seller_id,
          subagent_id: seller.subagent_id
        }
      });
      expect(issued.status).toBe(201);

      await transport.send({
        message_id: "msg_task_auto_1",
        from: "buyer-controller",
        to: seller.seller_id,
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_token: issued.body.task_token,
        simulate: "success",
        delay_ms: 20
      });

      const pulled = await jsonRequest(autoSellerUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(pulled.status).toBe(200);
      expect(pulled.body.accepted.length).toBe(1);

      const events = await waitFor(async () => {
        const polled = await jsonRequest(platformUrl, `/v1/requests/${requestId}/events`, {
          headers: authHeader
        });
        if (!polled.body.events.some((event) => event.event_type === "ACKED")) {
          throw new Error("ack_not_ready");
        }
        return polled;
      });
      expect(events.body.events.some((event) => event.event_type === "ACKED")).toBe(true);

      const buyerQueue = await waitFor(async () => {
        const polled = await buyerTransport.peek();
        if (polled.items.length === 0) {
          throw new Error("buyer_result_not_ready");
        }
        return polled;
      });
      expect(buyerQueue.items[0].result_package.status).toBe("ok");
      expect(buyerQueue.items[0].request_id).toBe(requestId);
    } finally {
      await closeServer(autoSellerServer);
      await closeServer(platformServer);
    }
  });
});
