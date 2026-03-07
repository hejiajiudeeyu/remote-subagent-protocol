import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "../../apps/platform-api/src/server.js";
import { createSellerControllerServer, createSellerState } from "../../apps/seller-controller/src/server.js";
import { createFunctionExecutor, startSellerHeartbeatLoop } from "../../packages/seller-runtime-core/src/index.js";
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
    expect(result.body.result_package.result_version).toBe("0.1.0");
    expect(result.body.result_package.seller_id).toBe("seller_foxlab");
    expect(result.body.result_package.subagent_id).toBe("foxlab.text.classifier.v1");
    expect(result.body.result_package.timing.accepted_at).toBeTypeOf("string");
    expect(result.body.result_package.timing.finished_at).toBeTypeOf("string");
    expect(result.body.result_package.timing.elapsed_ms).toBeTypeOf("number");
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
    expect(result.body.result_package.error.retryable).toBe(false);
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

  it("supports injected executors for local processing facilities", async () => {
    const hub = createLocalTransportHub();
    const sellerState = createSellerState({
      sellerId: "seller_runtime_custom",
      subagentIds: ["runtime.custom.v1"]
    });
    const sellerTransport = createLocalTransportAdapter({ hub, receiver: "seller_runtime_custom" });
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const customExecutor = createFunctionExecutor(async ({ requestId, taskType, taskInput, payload, subagentId }) => ({
      status: "ok",
      output: {
        request_id: requestId,
        handled_by: "custom-function-executor",
        subagent_id: subagentId,
        task_type: taskType,
        echo: taskInput?.text || payload?.text || null
      },
      schema_valid: true,
      usage: { tokens_in: 3, tokens_out: 2 }
    }));
    const customServer = createSellerControllerServer({
      serviceName: "seller-controller-custom-executor-test",
      state: sellerState,
      transport: sellerTransport,
      executor: customExecutor
    });
    const customUrl = await listenServer(customServer);

    try {
      await sellerTransport.send({
        message_id: "msg_custom_exec_1",
        from: "buyer-controller",
        to: "seller_runtime_custom",
        request_id: "req_custom_exec_1",
        seller_id: "seller_runtime_custom",
        subagent_id: "runtime.custom.v1",
        task_type: "extract",
        payload: { text: "hello-runtime" },
        delay_ms: 20
      });

      const pulled = await jsonRequest(customUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(pulled.status).toBe(200);
      expect(pulled.body.accepted).toHaveLength(1);

      const buyerQueue = await waitFor(async () => {
        const queue = await buyerTransport.peek();
        if (queue.items.length === 0) {
          throw new Error("custom_result_not_ready");
        }
        return queue;
      });

      expect(buyerQueue.items[0].result_package.status).toBe("ok");
      expect(buyerQueue.items[0].result_package.output).toEqual({
        request_id: "req_custom_exec_1",
        handled_by: "custom-function-executor",
        subagent_id: "runtime.custom.v1",
        task_type: "extract",
        echo: "hello-runtime"
      });
      expect(buyerQueue.items[0].result_package.usage).toEqual({
        tokens_in: 3,
        tokens_out: 2
      });
    } finally {
      await closeServer(customServer);
    }
  });

  it("dedupes repeated request_id and replays completed result", async () => {
    const hub = createLocalTransportHub();
    const sellerState = createSellerState({
      sellerId: "seller_foxlab",
      subagentIds: ["foxlab.text.classifier.v1"]
    });
    const sellerTransport = createLocalTransportAdapter({ hub, receiver: "seller_foxlab" });
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const dedupeServer = createSellerControllerServer({
      serviceName: "seller-controller-dedupe-test",
      state: sellerState,
      transport: sellerTransport
    });
    const dedupeUrl = await listenServer(dedupeServer);

    try {
      await sellerTransport.send({
        message_id: "msg_dedupe_1",
        from: "buyer-controller",
        to: "seller_foxlab",
        request_id: "req_seller_dedupe_1",
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1",
        simulate: "success",
        delay_ms: 100
      });

      const firstPull = await jsonRequest(dedupeUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(firstPull.status).toBe(200);
      expect(firstPull.body.accepted).toHaveLength(1);

      await sellerTransport.send({
        message_id: "msg_dedupe_2",
        from: "buyer-controller",
        to: "seller_foxlab",
        request_id: "req_seller_dedupe_1",
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1",
        simulate: "success",
        delay_ms: 100
      });

      const secondPull = await jsonRequest(dedupeUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(secondPull.status).toBe(200);
      expect(secondPull.body.accepted[0]).toMatchObject({
        deduped: true,
        replayed: false
      });
      expect(sellerState.tasks.size).toBe(1);

      await waitFor(async () => {
        const queue = await buyerTransport.peek();
        if (queue.items.length < 1) {
          throw new Error("initial_result_not_ready");
        }
        return queue;
      });

      await sellerTransport.send({
        message_id: "msg_dedupe_3",
        from: "buyer-controller",
        to: "seller_foxlab",
        request_id: "req_seller_dedupe_1",
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1",
        simulate: "success",
        delay_ms: 100
      });

      const thirdPull = await jsonRequest(dedupeUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(thirdPull.status).toBe(200);
      expect(thirdPull.body.accepted[0]).toMatchObject({
        deduped: true,
        replayed: true
      });

      const replayedQueue = await waitFor(async () => {
        const queue = await buyerTransport.peek();
        if (queue.items.length < 2) {
          throw new Error("replayed_result_not_ready");
        }
        return queue;
      });
      expect(replayedQueue.items[1].result_package.request_id).toBe("req_seller_dedupe_1");
      expect(replayedQueue.items[1].result_package.status).toBe("ok");
    } finally {
      await closeServer(dedupeServer);
    }
  });

  it("applies guardrails and reports seller metrics", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-seller-guardrail-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const seller = platformState.bootstrap.sellers[0];
    const hub = createLocalTransportHub();
    const sellerTransport = createLocalTransportAdapter({ hub, receiver: seller.seller_id });
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const guardedServer = createSellerControllerServer({
      serviceName: "seller-controller-guardrail-test",
      transport: sellerTransport,
      platform: {
        baseUrl: platformUrl,
        apiKey: seller.api_key,
        sellerId: seller.seller_id
      },
      guardrails: {
        maxHardTimeoutS: 60,
        allowedTaskTypes: ["extract"]
      }
    });
    const guardedUrl = await listenServer(guardedServer);

    try {
      const registered = await jsonRequest(platformUrl, "/v1/users/register", {
        method: "POST",
        body: { contact_email: "seller-guardrail@test.local" }
      });
      const authHeader = { Authorization: `Bearer ${registered.body.api_key}` };
      const requestId = "req_seller_guardrail_1";

      const issued = await jsonRequest(platformUrl, "/v1/tokens/task", {
        method: "POST",
        headers: authHeader,
        body: {
          request_id: requestId,
          seller_id: seller.seller_id,
          subagent_id: seller.subagent_id
        }
      });

      await sellerTransport.send({
        message_id: "msg_guardrail_1",
        from: "buyer-controller",
        to: seller.seller_id,
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_type: "classify",
        constraints: {
          hard_timeout_s: 120
        },
        task_token: issued.body.task_token
      });

      const pulled = await jsonRequest(guardedUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(pulled.status).toBe(200);

      const buyerQueue = await waitFor(async () => {
        const queue = await buyerTransport.peek();
        if (queue.items.length === 0) {
          throw new Error("guardrail_result_not_ready");
        }
        return queue;
      });
      expect(buyerQueue.items[0].result_package.status).toBe("error");
      expect(buyerQueue.items[0].result_package.error.code).toBe("CONTRACT_TIMEOUT_EXCEEDS_SELLER_LIMIT");

      const metrics = await jsonRequest(platformUrl, "/v1/metrics/summary", {
        headers: {
          Authorization: `Bearer ${seller.api_key}`
        }
      });
      expect(metrics.status).toBe(200);
      expect(metrics.body.by_type["seller.task.received"]).toBeGreaterThanOrEqual(1);
      expect(metrics.body.by_type["seller.task.rejected"]).toBeGreaterThanOrEqual(1);
    } finally {
      await closeServer(guardedServer);
      await closeServer(platformServer);
    }
  });

  it("starts heartbeat loop and updates platform availability", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-seller-heartbeat-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const seller = platformState.bootstrap.sellers[0];
    const state = createSellerState({
      sellerId: seller.seller_id,
      subagentIds: [seller.subagent_id],
      signing: seller.signing
    });

    const stopHeartbeat = startSellerHeartbeatLoop({
      state,
      platform: {
        baseUrl: platformUrl,
        apiKey: seller.api_key,
        sellerId: seller.seller_id
      },
      intervalMs: 50,
      logger: { warn() {} }
    });

    try {
      await waitFor(async () => {
        if (!state.heartbeat.last_sent_at) {
          throw new Error("heartbeat_not_sent");
        }

        const catalog = await jsonRequest(platformUrl, "/v1/catalog/subagents");
        const item = catalog.body.items.find((candidate) => candidate.subagent_id === seller.subagent_id);
        if (!item?.last_heartbeat_at || Date.parse(item.last_heartbeat_at) < Date.parse(state.heartbeat.last_sent_at)) {
          throw new Error("heartbeat_not_updated");
        }
        return item;
      });
      expect(state.heartbeat.last_sent_at).toBeTypeOf("string");
    } finally {
      stopHeartbeat();
      await closeServer(platformServer);
    }
  });
});
