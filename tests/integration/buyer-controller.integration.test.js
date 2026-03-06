import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBuyerControllerServer } from "../../apps/buyer-controller/src/server.js";
import { createLocalTransportAdapter, createLocalTransportHub } from "../../packages/transports/local/src/index.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

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
    expect(second.body.error).toBe("REQUEST_ALREADY_TERMINAL");
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
});
