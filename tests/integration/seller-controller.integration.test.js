import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createSellerControllerServer, createSellerState } from "@delexec/seller-controller";
import { createFunctionExecutor, createSubagentRouterExecutor, startSellerHeartbeatLoop } from "@delexec/seller-runtime-core";
import { createLocalTransportAdapter, createLocalTransportHub } from "@delexec/transport-local";
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
    expect(replayEarly.body.error.code).toBe("RESULT_NOT_READY");

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

  it("registers seller identities through seller-controller", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-seller-register-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const sellerServer = createSellerControllerServer({
      serviceName: "seller-controller-register-test",
      platform: {
        baseUrl: platformUrl
      },
      state: createSellerState({
        sellerId: "seller_register_test",
        subagentIds: ["register.test.v1"]
      })
    });
    const sellerUrl = await listenServer(sellerServer);

    try {
      const registered = await jsonRequest(sellerUrl, "/controller/register", {
        method: "POST",
        body: {
          display_name: "Register Test Seller",
          task_types: ["contract_extract"],
          capabilities: ["contract.extract"],
          tags: ["legal"]
        }
      });
      expect(registered.status).toBe(201);
      expect(registered.body.seller_id).toBe("seller_register_test");
      expect(registered.body.subagent_id).toBe("register.test.v1");
      expect(registered.body.api_key).toMatch(/^sk_seller_/);
      expect(registered.body.review_status).toBe("pending");

      const catalog = await jsonRequest(platformUrl, "/v1/catalog/subagents?capability=contract.extract");
      expect(catalog.status).toBe(200);
      expect(catalog.body.items.some((item) => item.subagent_id === "register.test.v1")).toBe(false);

      const approved = await jsonRequest(platformUrl, "/v1/admin/subagents/register.test.v1/approve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${platformState.adminApiKey}`
        },
        body: { reason: "approved for seller runtime" }
      });
      expect(approved.status).toBe(200);

      const approveSeller = await jsonRequest(platformUrl, "/v1/admin/sellers/seller_register_test/approve", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${platformState.adminApiKey}`
        },
        body: { reason: "seller approved for runtime" }
      });
      expect(approveSeller.status).toBe(200);

      const enabledCatalog = await jsonRequest(platformUrl, "/v1/catalog/subagents?capability=contract.extract");
      expect(enabledCatalog.status).toBe(200);
      expect(enabledCatalog.body.items.some((item) => item.subagent_id === "register.test.v1")).toBe(true);
    } finally {
      await closeServer(sellerServer);
      await closeServer(platformServer);
    }
  });

  it("registers through seller-controller with a buyer api key and stores the issued seller credentials", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-seller-register-owned-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const buyer = await jsonRequest(platformUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "seller-owner@test.local" }
    });
    const platformConfig = {
      baseUrl: platformUrl,
      apiKey: null,
      sellerId: null
    };
    const state = createSellerState({
      sellerId: "seller_owned_test",
      subagentIds: ["owned.test.v1"]
    });
    const sellerServer = createSellerControllerServer({
      serviceName: "seller-controller-register-owned-test",
      platform: platformConfig,
      state
    });
    const sellerUrl = await listenServer(sellerServer);

    try {
      const registered = await jsonRequest(sellerUrl, "/controller/register", {
        method: "POST",
        headers: {
          "X-Platform-Api-Key": buyer.body.api_key
        },
        body: {
          display_name: "Owned Test Seller"
        }
      });
      expect(registered.status).toBe(201);
      expect(registered.body.owner_user_id).toBe(buyer.body.user_id);
      expect(platformConfig.apiKey).toBe(registered.body.api_key);
      expect(platformConfig.sellerId).toBe("seller_owned_test");
      expect(platformState.users.get(buyer.body.user_id).roles).toEqual(["buyer", "seller"]);
      expect(registered.body.review_status).toBe("pending");
    } finally {
      await closeServer(sellerServer);
      await closeServer(platformServer);
    }
  });

  it("executes tasks through a configured process adapter", async () => {
    const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "seller-process-adapter-"));
    const scriptPath = path.join(scriptDir, "worker.js");
    fs.writeFileSync(
      scriptPath,
      "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const input=JSON.parse(data);process.stdout.write(JSON.stringify({status:'ok',output:{adapter:'process',request_id:input.request_id,summary:input.input?.text||null},usage:{tokens_in:1,tokens_out:1}}));});\n",
      "utf8"
    );

    const processServer = createSellerControllerServer({
      serviceName: "seller-controller-process-adapter-test",
      state: createSellerState({
        sellerId: "seller_process_adapter",
        subagentIds: ["process.adapter.v1"],
        subagents: [
          {
            subagent_id: "process.adapter.v1",
            display_name: "Process Adapter",
            enabled: true,
            adapter_type: "process",
            adapter: {
              cmd: `node ${scriptPath}`
            },
            task_types: ["summarize"]
          }
        ]
      }),
      executor: createSubagentRouterExecutor([
        {
          subagent_id: "process.adapter.v1",
          display_name: "Process Adapter",
          enabled: true,
          adapter_type: "process",
          adapter: {
            cmd: `node ${scriptPath}`
          },
          task_types: ["summarize"]
        }
      ])
    });
    const processUrl = await listenServer(processServer);

    try {
      const created = await jsonRequest(processUrl, "/controller/tasks", {
        method: "POST",
        body: {
          request_id: "req_process_adapter_1",
          subagent_id: "process.adapter.v1",
          task_type: "summarize",
          task_input: { text: "hello process" }
        }
      });
      expect(created.status).toBe(202);

      const result = await waitFor(async () => {
        const polled = await jsonRequest(processUrl, `/controller/tasks/${created.body.task_id}/result`);
        if (polled.status !== 200 || polled.body.available !== true) {
          throw new Error("result_not_ready");
        }
        return polled;
      });

      expect(result.body.result_package.output.adapter).toBe("process");
      expect(result.body.result_package.output.summary).toBe("hello process");
    } finally {
      await closeServer(processServer);
      fs.rmSync(scriptDir, { recursive: true, force: true });
    }
  });

  it("executes tasks through a configured http adapter", async () => {
    const { createServer } = await import("node:http");
    const adapterServer = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            status: "ok",
            output: {
              adapter: "http",
              echoed_request_id: body.request_id
            },
            usage: { tokens_in: 1, tokens_out: 1 }
          })
        );
      });
    });
    const adapterUrl = await listenServer(adapterServer);

    const httpServer = createSellerControllerServer({
      serviceName: "seller-controller-http-adapter-test",
      state: createSellerState({
        sellerId: "seller_http_adapter",
        subagentIds: ["http.adapter.v1"],
        subagents: [
          {
            subagent_id: "http.adapter.v1",
            display_name: "HTTP Adapter",
            enabled: true,
            adapter_type: "http",
            adapter: {
              url: adapterUrl
            }
          }
        ]
      }),
      executor: createSubagentRouterExecutor([
        {
          subagent_id: "http.adapter.v1",
          display_name: "HTTP Adapter",
          enabled: true,
          adapter_type: "http",
          adapter: {
            url: adapterUrl
          }
        }
      ])
    });
    const httpUrl = await listenServer(httpServer);

    try {
      const created = await jsonRequest(httpUrl, "/controller/tasks", {
        method: "POST",
        body: {
          request_id: "req_http_adapter_1",
          subagent_id: "http.adapter.v1"
        }
      });
      expect(created.status).toBe(202);

      const result = await waitFor(async () => {
        const polled = await jsonRequest(httpUrl, `/controller/tasks/${created.body.task_id}/result`);
        if (polled.status !== 200 || polled.body.available !== true) {
          throw new Error("result_not_ready");
        }
        return polled;
      });

      expect(result.body.result_package.output.adapter).toBe("http");
      expect(result.body.result_package.output.echoed_request_id).toBe("req_http_adapter_1");
    } finally {
      await closeServer(httpServer);
      await closeServer(adapterServer);
    }
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
        if (!polled.body.events.some((event) => event.event_type === "COMPLETED")) {
          throw new Error("completed_not_ready");
        }
        return polled;
      });
      expect(events.body.events.some((event) => event.event_type === "ACKED")).toBe(true);
      expect(events.body.events.some((event) => event.event_type === "COMPLETED")).toBe(true);

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

  it("reports FAILED event to platform when execution returns error", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-failed-event-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const hub = createLocalTransportHub();
    const seller = platformState.bootstrap.sellers[0];
    const transport = createLocalTransportAdapter({ hub, receiver: seller.seller_id });
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const sellerServer = createSellerControllerServer({
      serviceName: "seller-controller-failed-event-test",
      transport,
      platform: {
        baseUrl: platformUrl,
        apiKey: seller.api_key,
        sellerId: seller.seller_id
      }
    });
    const sellerUrl = await listenServer(sellerServer);

    try {
      const registered = await jsonRequest(platformUrl, "/v1/users/register", {
        method: "POST",
        body: { contact_email: "seller-failed@test.local" }
      });
      const authHeader = { Authorization: `Bearer ${registered.body.api_key}` };
      const requestId = "req_seller_failed_event_1";

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
        message_id: "msg_task_failed_1",
        from: "buyer-controller",
        to: seller.seller_id,
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_token: issued.body.task_token,
        simulate: "token_expired",
        delay_ms: 20
      });

      const pulled = await jsonRequest(sellerUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(pulled.status).toBe(200);

      const events = await waitFor(async () => {
        const polled = await jsonRequest(platformUrl, `/v1/requests/${requestId}/events`, {
          headers: authHeader
        });
        if (!polled.body.events.some((event) => event.event_type === "FAILED")) {
          throw new Error("failed_not_ready");
        }
        return polled;
      });
      expect(events.body.events.some((event) => event.event_type === "ACKED")).toBe(true);
      const failedEvent = events.body.events.find((event) => event.event_type === "FAILED");
      expect(failedEvent.error_code).toBe("AUTH_TOKEN_EXPIRED");

      const buyerQueue = await waitFor(async () => {
        const polled = await buyerTransport.peek();
        if (polled.items.length === 0) {
          throw new Error("buyer_failed_result_not_ready");
        }
        return polled;
      });
      expect(buyerQueue.items[0].result_package.status).toBe("error");
    } finally {
      await closeServer(sellerServer);
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

  it("runs queued tasks concurrently when worker concurrency is greater than one", async () => {
    let activeExecutions = 0;
    let maxConcurrentExecutions = 0;
    const concurrentState = createSellerState({
      sellerId: "seller_concurrent",
      subagentIds: ["seller.concurrent.v1"],
      workerConcurrency: 2
    });
    const concurrentServer = createSellerControllerServer({
      serviceName: "seller-controller-concurrency-test",
      state: concurrentState,
      executor: createFunctionExecutor(async ({ requestId }) => {
        activeExecutions += 1;
        maxConcurrentExecutions = Math.max(maxConcurrentExecutions, activeExecutions);
        await new Promise((resolve) => setTimeout(resolve, 120));
        activeExecutions -= 1;
        return {
          status: "ok",
          output: {
            request_id: requestId,
            mode: "concurrent"
          },
          schema_valid: true,
          usage: { tokens_in: 1, tokens_out: 1 }
        };
      })
    });
    const concurrentUrl = await listenServer(concurrentServer);

    try {
      const health = await jsonRequest(concurrentUrl, "/");
      expect(health.status).toBe(200);
      expect(health.body.worker_concurrency).toBe(2);

      for (const requestId of ["req_seller_concurrent_1", "req_seller_concurrent_2", "req_seller_concurrent_3"]) {
        const accepted = await jsonRequest(concurrentUrl, "/controller/tasks", {
          method: "POST",
          body: {
            request_id: requestId,
            seller_id: "seller_concurrent",
            subagent_id: "seller.concurrent.v1",
            delay_ms: 10
          }
        });
        expect(accepted.status).toBe(202);
        expect(accepted.body.queue_policy.worker_concurrency).toBe(2);
      }

      await waitFor(async () => {
        const queue = await jsonRequest(concurrentUrl, "/controller/queue");
        const completed = Array.from(concurrentState.tasks.values()).filter((task) => task.status === "COMPLETED");
        if (queue.body.running.length > 0 || completed.length < 3) {
          throw new Error("concurrent_tasks_not_completed");
        }
        return completed;
      }, { timeoutMs: 6000, intervalMs: 50 });

      expect(maxConcurrentExecutions).toBeGreaterThanOrEqual(2);
    } finally {
      await closeServer(concurrentServer);
    }
  });
});
