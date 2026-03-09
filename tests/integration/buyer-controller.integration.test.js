import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBuyerControllerServer } from "@croc/buyer-controller";
import { createBuyerControllerServer as createBuyerControllerCoreServer } from "@croc/buyer-controller-core";
import { createPlatformServer, createPlatformState } from "@croc/platform-api";
import { createSellerControllerServer, createSellerState } from "@croc/seller-controller";
import { createLocalTransportAdapter, createLocalTransportHub } from "@croc/transport-local";
import { closeServer, jsonRequest, listenServer, waitFor } from "../helpers/http.js";

describe("buyer-controller integration", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = createBuyerControllerServer({
      serviceName: "buyer-controller-test",
      config: {
        timeout_confirmation_mode: "ask_by_default",
        hard_timeout_auto_finalize: true,
        poll_interval_active_s: 1,
        poll_interval_backoff_s: 1
      }
    });
    baseUrl = await listenServer(server);
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("auto-finalizes hard timeout", async () => {
    const requestId = "req_buyer_timeout_1";
    const created = await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        soft_timeout_s: 1,
        hard_timeout_s: 1
      }
    });
    expect(created.status).toBe(201);

    await new Promise((resolve) => setTimeout(resolve, 1300));

    const queried = await jsonRequest(baseUrl, `/controller/requests/${requestId}`);
    expect(queried.status).toBe(200);
    expect(queried.body.status).toBe("TIMED_OUT");
  });

  it("accepts timeout decision to continue waiting", async () => {
    const requestId = "req_buyer_continue_1";
    await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        soft_timeout_s: 1,
        hard_timeout_s: 2
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const decision = await jsonRequest(baseUrl, `/controller/requests/${requestId}/timeout-decision`, {
      method: "POST",
      body: {
        continue_wait: true
      }
    });

    expect(decision.status).toBe(200);
    expect(decision.body.timeout_decision).toBe("continue_wait");
    expect(decision.body.status).not.toBe("TIMED_OUT");
  });

  it("times out sent requests that miss ack_deadline", async () => {
    const requestId = "req_buyer_ack_deadline_1";
    const created = await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        ack_deadline_s: 1,
        soft_timeout_s: 30,
        hard_timeout_s: 60
      }
    });
    expect(created.status).toBe(201);

    const marked = await jsonRequest(baseUrl, `/controller/requests/${requestId}/mark-sent`, {
      method: "POST"
    });
    expect(marked.status).toBe(200);
    expect(marked.body.status).toBe("SENT");
    expect(marked.body.ack_deadline_at).toBeTypeOf("string");

    await new Promise((resolve) => setTimeout(resolve, 1300));

    const queried = await jsonRequest(baseUrl, `/controller/requests/${requestId}`);
    expect(queried.status).toBe(200);
    expect(queried.body.status).toBe("TIMED_OUT");
    expect(queried.body.last_error_code).toBe("DELIVERY_OR_ACCEPTANCE_TIMEOUT");
  });

  it("rejects second result write after terminal state", async () => {
    const requestId = "req_buyer_terminal_1";
    await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        soft_timeout_s: 5,
        hard_timeout_s: 20
      }
    });

    const first = await jsonRequest(baseUrl, `/controller/requests/${requestId}/result`, {
      method: "POST",
      body: {
        request_id: requestId,
        status: "ok",
        output: { summary: "done" },
        schema_valid: true
      }
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("SUCCEEDED");

    const second = await jsonRequest(baseUrl, `/controller/requests/${requestId}/result`, {
      method: "POST",
      body: {
        request_id: requestId,
        status: "ok",
        output: { summary: "second" },
        schema_valid: true
      }
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("REQUEST_ALREADY_TERMINAL");
  });

  it("supports timeout decision to stop waiting", async () => {
    const requestId = "req_buyer_stop_1";
    await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        soft_timeout_s: 30,
        hard_timeout_s: 60
      }
    });

    const decision = await jsonRequest(baseUrl, `/controller/requests/${requestId}/timeout-decision`, {
      method: "POST",
      body: {
        continue_wait: false
      }
    });

    expect(decision.status).toBe(200);
    expect(decision.body.status).toBe("TIMED_OUT");
    expect(decision.body.last_error_code).toBe("EXEC_TIMEOUT_MANUAL_STOP");
  });

  it("pulls result packages from transport inbox", async () => {
    const hub = createLocalTransportHub();
    const transport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const inboxServer = createBuyerControllerServer({
      serviceName: "buyer-controller-inbox-test",
      transport
    });
    const inboxUrl = await listenServer(inboxServer);

    try {
      const requestId = "req_buyer_inbox_1";
      await jsonRequest(inboxUrl, "/controller/requests", {
        method: "POST",
        body: {
          request_id: requestId,
          expected_signer_public_key_pem: null
        }
      });

      await transport.send({
        message_id: "msg_result_1",
        to: "buyer-controller",
        result_package: {
          request_id: requestId,
          status: "error",
          error: { code: "EXEC_INTERNAL_ERROR", message: "boom" },
          schema_valid: true
        }
      });

      const pulled = await jsonRequest(inboxUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(pulled.status).toBe(200);
      expect(pulled.body.accepted).toEqual([{ message_id: "msg_result_1", request_id: requestId }]);

      const final = await jsonRequest(inboxUrl, `/controller/requests/${requestId}`);
      expect(final.body.status).toBe("FAILED");
      expect(final.body.last_error_code).toBe("EXEC_INTERNAL_ERROR");
    } finally {
      await closeServer(inboxServer);
    }
  });

  it("supports direct core import for embedded dispatch", async () => {
    const hub = createLocalTransportHub();
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const sellerTransport = createLocalTransportAdapter({ hub, receiver: "seller_embed" });
    const coreServer = createBuyerControllerCoreServer({
      serviceName: "buyer-controller-core-test",
      transport: buyerTransport
    });
    const coreUrl = await listenServer(coreServer);

    try {
      const requestId = "req_buyer_core_dispatch_1";
      const created = await jsonRequest(coreUrl, "/controller/requests", {
        method: "POST",
        body: {
          request_id: requestId,
          seller_id: "seller_embed",
          subagent_id: "embed.runtime.v1"
        }
      });
      expect(created.status).toBe(201);

      const dispatched = await jsonRequest(coreUrl, `/controller/requests/${requestId}/dispatch`, {
        method: "POST",
        body: {
          task_token: "task_token_embed_1",
          payload: { prompt: "hello-embedded-buyer" },
          priority: 2,
          delay_ms: 15
        }
      });
      expect(dispatched.status).toBe(202);

      const queue = await sellerTransport.peek();
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]).toMatchObject({
        request_id: requestId,
        seller_id: "seller_embed",
        subagent_id: "embed.runtime.v1",
        task_token: "task_token_embed_1",
        payload: { prompt: "hello-embedded-buyer" },
        priority: 2,
        delay_ms: 15
      });
    } finally {
      await closeServer(coreServer);
    }
  });

  it("returns stable result reads for terminal requests", async () => {
    const requestId = "req_buyer_result_read_1";
    await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        soft_timeout_s: 5,
        hard_timeout_s: 20
      }
    });

    const before = await jsonRequest(baseUrl, `/controller/requests/${requestId}/result`);
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      available: false,
      status: "CREATED",
      result_package: null
    });

    await jsonRequest(baseUrl, `/controller/requests/${requestId}/result`, {
      method: "POST",
      body: {
        request_id: requestId,
        status: "ok",
        output: { summary: "done" },
        schema_valid: true
      }
    });

    const after = await jsonRequest(baseUrl, `/controller/requests/${requestId}/result`);
    expect(after.status).toBe(200);
    expect(after.body.available).toBe(true);
    expect(after.body.status).toBe("SUCCEEDED");
    expect(after.body.result_package.output).toEqual({ summary: "done" });
  });

  it("builds task contract drafts from prepared requests", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-buyer-contract-test", state: platformState });
    const platformUrl = await listenServer(platformServer);

    const registered = await jsonRequest(platformUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "buyer-contract@test.local" }
    });
    const buyerServer = createBuyerControllerCoreServer({
      serviceName: "buyer-controller-contract-test",
      platform: {
        baseUrl: platformUrl,
        apiKey: registered.body.api_key
      }
    });
    const buyerUrl = await listenServer(buyerServer);

    try {
      const requestId = "req_buyer_contract_1";
      const created = await jsonRequest(buyerUrl, "/controller/requests", {
        method: "POST",
        body: {
          request_id: requestId,
          buyer_id: "buyer_contract",
          seller_id: "seller_foxlab",
          subagent_id: "foxlab.text.classifier.v1",
          soft_timeout_s: 90,
          hard_timeout_s: 300
        }
      });
      expect(created.status).toBe(201);

      const prepared = await jsonRequest(buyerUrl, `/controller/requests/${requestId}/prepare`, {
        method: "POST",
        body: {}
      });
      expect(prepared.status).toBe(200);

      const drafted = await jsonRequest(buyerUrl, `/controller/requests/${requestId}/contract-draft`, {
        method: "POST",
        body: {
          task_type: "text_classification",
          input: {
            text: "The package arrived damaged and I want a full refund."
          },
          output_schema: {
            type: "object",
            required: ["label", "confidence"],
            properties: {
              label: { type: "string" },
              confidence: { type: "number" }
            }
          },
          return_route_hint: "local://buyer-agent/inbox/default",
          source_run_id: "run_buyer_contract_001"
        }
      });
      expect(drafted.status).toBe(200);
      expect(drafted.body.contract).toMatchObject({
        request_id: requestId,
        contract_version: "0.1.0",
        buyer: {
          buyer_id: "buyer_contract",
          return_route_hint: "local://buyer-agent/inbox/default"
        },
        seller: {
          seller_id: "seller_foxlab",
          subagent_id: "foxlab.text.classifier.v1"
        },
        task: {
          task_type: "text_classification",
          input: {
            text: "The package arrived damaged and I want a full refund."
          }
        },
        constraints: {
          soft_timeout_s: 90,
          hard_timeout_s: 300
        },
        token: prepared.body.task_token
      });
      expect(drafted.body.contract.trace.thread_hint).toBe(prepared.body.delivery_meta.thread_hint);
      expect(drafted.body.contract.trace.source_run_id).toBe("run_buyer_contract_001");
    } finally {
      await closeServer(buyerServer);
      await closeServer(platformServer);
    }
  });

  it("reports buyer metrics for dispatch, ack, and result", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-buyer-metrics-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const registered = await jsonRequest(platformUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "buyer-metrics@test.local" }
    });
    const seller = platformState.bootstrap.sellers[0];
    const hub = createLocalTransportHub();
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const sellerTransport = createLocalTransportAdapter({ hub, receiver: seller.seller_id });
    const buyerServer = createBuyerControllerCoreServer({
      serviceName: "buyer-controller-metrics-test",
      transport: buyerTransport,
      platform: {
        baseUrl: platformUrl,
        apiKey: registered.body.api_key
      }
    });
    const sellerServer = createSellerControllerServer({
      serviceName: "seller-controller-buyer-metrics-test",
      transport: sellerTransport,
      platform: {
        baseUrl: platformUrl,
        apiKey: seller.api_key,
        sellerId: seller.seller_id
      },
      state: createSellerState({
        sellerId: seller.seller_id,
        subagentIds: [seller.subagent_id],
        signing: seller.signing
      })
    });
    const buyerUrl = await listenServer(buyerServer);
    const sellerUrl = await listenServer(sellerServer);

    try {
      const requestId = "req_buyer_metrics_1";
      await jsonRequest(buyerUrl, "/controller/requests", {
        method: "POST",
        body: {
          request_id: requestId,
          buyer_id: "buyer_metrics",
          seller_id: seller.seller_id,
          subagent_id: seller.subagent_id
        }
      });

      await jsonRequest(buyerUrl, `/controller/requests/${requestId}/prepare`, {
        method: "POST",
        body: {}
      });
      await jsonRequest(buyerUrl, `/controller/requests/${requestId}/dispatch`, {
        method: "POST",
        body: {
          payload: { prompt: "metrics-test" },
          delay_ms: 20
        }
      });

      await jsonRequest(sellerUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      await waitFor(async () => {
        const queue = await buyerTransport.peek();
        if (queue.items.length === 0) {
          throw new Error("buyer_metrics_result_not_ready");
        }
        return queue;
      });
      await jsonRequest(buyerUrl, `/controller/requests/${requestId}/sync-events`, {
        method: "POST"
      });
      await jsonRequest(buyerUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });

      const metrics = await jsonRequest(platformUrl, "/v1/metrics/summary", {
        headers: {
          Authorization: `Bearer ${registered.body.api_key}`
        }
      });
      expect(metrics.status).toBe(200);
      expect(metrics.body.by_type["buyer.request.dispatched"]).toBeGreaterThanOrEqual(1);
      expect(metrics.body.by_type["buyer.request.acked"]).toBeGreaterThanOrEqual(1);
      expect(metrics.body.by_type["buyer.request.succeeded"]).toBeGreaterThanOrEqual(1);
    } finally {
      await closeServer(buyerServer);
      await closeServer(sellerServer);
      await closeServer(platformServer);
    }
  });

  it("orchestrates catalog, prepare, dispatch, and ACK sync through platform", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-buyer-orch-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const hub = createLocalTransportHub();
    const bootstrapSeller = platformState.bootstrap.sellers[0];
    const buyerTransport = createLocalTransportAdapter({ hub, receiver: "buyer-controller" });
    const sellerTransport = createLocalTransportAdapter({ hub, receiver: bootstrapSeller.seller_id });
    const sellerServer = createSellerControllerServer({
      serviceName: "seller-controller-buyer-orch-test",
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
      })
    });
    const sellerUrl = await listenServer(sellerServer);

    const registered = await jsonRequest(platformUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "buyer-orch@test.local" }
    });
    const buyerServer = createBuyerControllerCoreServer({
      serviceName: "buyer-controller-orch-test",
      transport: buyerTransport,
      platform: {
        baseUrl: platformUrl,
        apiKey: registered.body.api_key
      },
      config: {
        timeout_confirmation_mode: "ask_by_default",
        hard_timeout_auto_finalize: true,
        poll_interval_active_s: 1,
        poll_interval_backoff_s: 1
      }
    });
    const buyerUrl = await listenServer(buyerServer);

    try {
      const catalog = await jsonRequest(buyerUrl, "/controller/catalog/subagents?status=enabled");
      expect(catalog.status).toBe(200);
      expect(catalog.body.items.length).toBeGreaterThan(0);
      const selected = catalog.body.items[0];

      const requestId = "req_buyer_orchestrated_1";
      const created = await jsonRequest(buyerUrl, "/controller/requests", {
        method: "POST",
        body: {
          request_id: requestId,
          soft_timeout_s: 5,
          hard_timeout_s: 10
        }
      });
      expect(created.status).toBe(201);

      const prepared = await jsonRequest(buyerUrl, `/controller/requests/${requestId}/prepare`, {
        method: "POST",
        body: {
          seller_id: selected.seller_id,
          subagent_id: selected.subagent_id
        }
      });
      expect(prepared.status).toBe(200);
      expect(prepared.body.task_token).toBeTypeOf("string");
      expect(prepared.body.delivery_meta.delivery_address).toBeTypeOf("string");
      expect(prepared.body.delivery_meta.delivery_address.startsWith("local://")).toBe(true);
      expect(prepared.body.request.expected_signer_public_key_pem).toBe(selected.seller_public_key_pem);

      const dispatched = await jsonRequest(buyerUrl, `/controller/requests/${requestId}/dispatch`, {
        method: "POST",
        body: {
          simulate: "success",
          delay_ms: 20
        }
      });
      expect(dispatched.status).toBe(202);
      expect(dispatched.body.envelope.to).toBe(prepared.body.delivery_meta.delivery_address);

      const sellerQueue = await sellerTransport.peek();
      expect(sellerQueue.items).toHaveLength(1);
      expect(sellerQueue.items[0].to).toBe(prepared.body.delivery_meta.delivery_address);

      const pulled = await jsonRequest(sellerUrl, "/controller/inbox/pull", {
        method: "POST",
        body: {}
      });
      expect(pulled.status).toBe(200);
      expect(pulled.body.accepted).toHaveLength(1);

      const synced = await waitFor(async () => {
        const polled = await jsonRequest(buyerUrl, `/controller/requests/${requestId}/sync-events`, {
          method: "POST",
          body: {}
        });
        if (polled.body.acked !== true) {
          throw new Error("ack_not_synced");
        }
        return polled;
      });
      expect(synced.status).toBe(200);
      expect(synced.body.request.status).toBe("ACKED");

      const inbox = await waitFor(async () => {
        const polled = await jsonRequest(buyerUrl, "/controller/inbox/pull", {
          method: "POST",
          body: {}
        });
        if (polled.body.accepted.length !== 1) {
          throw new Error("buyer_result_not_ready");
        }
        return polled;
      });
      expect(inbox.body.accepted[0].request_id).toBe(requestId);

      const final = await jsonRequest(buyerUrl, `/controller/requests/${requestId}`);
      expect(final.status).toBe(200);
      expect(final.body.status).toBe("SUCCEEDED");
    } finally {
      await closeServer(buyerServer);
      await closeServer(sellerServer);
      await closeServer(platformServer);
    }
  });

  it("filters controller catalog by capability through platform", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-buyer-capability-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const registered = await jsonRequest(platformUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "buyer-capability@test.local" }
    });

    const sellerRegistration = await jsonRequest(platformUrl, "/v1/sellers/register", {
      method: "POST",
      body: {
        seller_id: "seller_legalworks",
        subagent_id: "legalworks.contract.extractor.v1",
        display_name: "LegalWorks Contract Extractor",
        seller_public_key_pem: platformState.bootstrap.sellers[0].signing.publicKeyPem,
        capabilities: ["contract.extract"],
        task_types: ["contract_extract"],
        tags: ["legal"]
      }
    });
    expect(sellerRegistration.status).toBe(201);
    expect(sellerRegistration.body.review_status).toBe("pending");

    const approved = await jsonRequest(platformUrl, "/v1/admin/subagents/legalworks.contract.extractor.v1/approve", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${platformState.adminApiKey}`
      },
      body: { reason: "ready for discovery" }
    });
    expect(approved.status).toBe(200);

    const buyerServer = createBuyerControllerCoreServer({
      serviceName: "buyer-controller-capability-test",
      platform: {
        baseUrl: platformUrl,
        apiKey: registered.body.api_key
      }
    });
    const buyerUrl = await listenServer(buyerServer);

    try {
      const catalog = await jsonRequest(buyerUrl, "/controller/catalog/subagents?capability=contract.extract");
      expect(catalog.status).toBe(200);
      expect(catalog.body.items).toHaveLength(1);
      expect(catalog.body.items[0].subagent_id).toBe("legalworks.contract.extractor.v1");
    } finally {
      await closeServer(buyerServer);
      await closeServer(platformServer);
    }
  });

  it("registers seller identities through buyer-controller using the buyer api key", async () => {
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-buyer-seller-register-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    const buyer = await jsonRequest(platformUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "buyer-seller-register@test.local" }
    });
    const buyerServer = createBuyerControllerCoreServer({
      serviceName: "buyer-controller-seller-register-test",
      platform: {
        baseUrl: platformUrl
      }
    });
    const buyerUrl = await listenServer(buyerServer);

    try {
      const registered = await jsonRequest(buyerUrl, "/controller/seller/register", {
        method: "POST",
        headers: {
          "X-Platform-Api-Key": buyer.body.api_key
        },
        body: {
          seller_id: "seller_from_buyer",
          subagent_id: "buyer.enabled.v1",
          display_name: "Buyer Enabled Seller",
          seller_public_key_pem: platformState.bootstrap.sellers[0].signing.publicKeyPem,
          capabilities: ["text.classify"]
        }
      });
      expect(registered.status).toBe(201);
      expect(registered.body.owner_user_id).toBe(buyer.body.user_id);
      expect(platformState.users.get(buyer.body.user_id).roles).toEqual(["buyer", "seller"]);
      expect(registered.body.review_status).toBe("pending");
    } finally {
      await closeServer(buyerServer);
      await closeServer(platformServer);
    }
  });

  it("marks mismatched result context as UNVERIFIED", async () => {
    const requestId = "req_buyer_context_1";
    await jsonRequest(baseUrl, "/controller/requests", {
      method: "POST",
      body: {
        request_id: requestId,
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1",
        soft_timeout_s: 5,
        hard_timeout_s: 20
      }
    });

    const result = await jsonRequest(baseUrl, `/controller/requests/${requestId}/result`, {
      method: "POST",
      body: {
        request_id: requestId,
        result_version: "0.1.0",
        seller_id: "seller_northwind",
        subagent_id: "northwind.copywriter.v1",
        status: "ok",
        output: { summary: "wrong-seller" },
        schema_valid: true
      }
    });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("UNVERIFIED");
    expect(result.body.last_error_code).toBe("RESULT_CONTEXT_MISMATCH");
  });
});
