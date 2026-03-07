import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "../../apps/platform-api/src/server.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

describe("platform-api integration", () => {
  let server;
  let baseUrl;
  let state;

  beforeAll(async () => {
    state = createPlatformState();
    server = createPlatformServer({ serviceName: "platform-api-test", state });
    baseUrl = await listenServer(server);
  });

  afterAll(async () => {
    await closeServer(server);
  });

  it("registers user, issues token, introspects token", async () => {
    const register = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { email: "integration-platform@test.local" }
    });
    expect(register.status).toBe(201);

    const auth = { Authorization: `Bearer ${register.body.api_key}` };

    const catalog = await jsonRequest(baseUrl, "/v1/catalog/subagents?status=active");
    expect(catalog.status).toBe(200);
    expect(catalog.body.items.length).toBeGreaterThan(0);

    const selected = catalog.body.items[0];

    const tokenRes = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: auth,
      body: {
        request_id: "req_integration_platform_1",
        seller_id: selected.seller_id,
        subagent_id: selected.subagent_id
      }
    });
    expect(tokenRes.status).toBe(201);
    expect(tokenRes.body.task_token).toBeTruthy();
    expect(tokenRes.body.claims).toMatchObject({
      request_id: "req_integration_platform_1",
      seller_id: selected.seller_id,
      subagent_id: selected.subagent_id,
      aud: selected.seller_id
    });
    expect(typeof tokenRes.body.claims.exp).toBe("number");

    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === selected.seller_id).api_key}`
    };
    const introspect = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
      method: "POST",
      headers: sellerAuth,
      body: { task_token: tokenRes.body.task_token }
    });
    expect(introspect.status).toBe(200);
    expect(introspect.body.active).toBe(true);

    const template = await jsonRequest(
      baseUrl,
      `/v1/catalog/subagents/${selected.subagent_id}/template-bundle?template_ref=${encodeURIComponent(selected.template_ref)}`
    );
    expect(template.status).toBe(200);
    expect(template.body.input_schema).toBeTypeOf("object");
    expect(template.body.output_schema).toBeTypeOf("object");
  });

  it("rejects token issuance without auth", async () => {
    const tokenRes = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      body: {
        request_id: "req_no_auth_1",
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1"
      }
    });
    expect(tokenRes.status).toBe(401);
    expect(tokenRes.body.error).toBe("AUTH_UNAUTHORIZED");
  });

  it("updates catalog availability via heartbeat", async () => {
    const register = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-heartbeat@test.local" }
    });
    const before = await jsonRequest(baseUrl, "/v1/catalog/subagents?availability_status=healthy");
    expect(before.status).toBe(200);
    expect(before.body.items.length).toBeGreaterThan(0);

    const target = before.body.items[0];
    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === target.seller_id).api_key}`
    };
    const heartbeat = await jsonRequest(baseUrl, `/v1/sellers/${target.seller_id}/heartbeat`, {
      method: "POST",
      headers: sellerAuth,
      body: { status: "degraded" }
    });
    expect(heartbeat.status).toBe(202);

    const degraded = await jsonRequest(baseUrl, "/v1/catalog/subagents?availability_status=degraded");
    expect(degraded.status).toBe(200);
    expect(degraded.body.items.some((item) => item.seller_id === target.seller_id)).toBe(true);
  });

  it("enforces request ownership and keeps ACK idempotent", async () => {
    const buyerOne = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-owner-1@test.local" }
    });
    const buyerTwo = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-owner-2@test.local" }
    });
    const requestId = "req_request_ownership_1";
    const seller = state.bootstrap.sellers[0];

    const token = await jsonRequest(baseUrl, "/v1/tokens/task", {
      method: "POST",
      headers: { Authorization: `Bearer ${buyerOne.body.api_key}` },
      body: {
        request_id: requestId,
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(token.status).toBe(201);

    const deliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${buyerOne.body.api_key}` },
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        task_token: token.body.task_token
      }
    });
    expect(deliveryMeta.status).toBe(200);

    const foreignEvents = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${buyerTwo.body.api_key}` }
    });
    expect(foreignEvents.status).toBe(403);
    expect(foreignEvents.body.error).toBe("AUTH_RESOURCE_FORBIDDEN");

    const foreignDeliveryMeta = await jsonRequest(baseUrl, `/v1/requests/${requestId}/delivery-meta`, {
      method: "POST",
      headers: { Authorization: `Bearer ${buyerTwo.body.api_key}` },
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id
      }
    });
    expect(foreignDeliveryMeta.status).toBe(403);
    expect(foreignDeliveryMeta.body.error).toBe("AUTH_RESOURCE_FORBIDDEN");

    const sellerAuth = {
      Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === seller.seller_id).api_key}`
    };
    const firstAck = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        eta_hint_s: 2
      }
    });
    expect(firstAck.status).toBe(202);

    const secondAck = await jsonRequest(baseUrl, `/v1/requests/${requestId}/ack`, {
      method: "POST",
      headers: sellerAuth,
      body: {
        seller_id: seller.seller_id,
        subagent_id: seller.subagent_id,
        eta_hint_s: 3
      }
    });
    expect(secondAck.status).toBe(202);

    const events = await jsonRequest(baseUrl, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${buyerOne.body.api_key}` }
    });
    expect(events.status).toBe(200);
    expect(events.body.events.filter((event) => event.event_type === "ACKED")).toHaveLength(1);
  });

  it("returns inactive for expired token", async () => {
    const register = await jsonRequest(baseUrl, "/v1/users/register", {
      method: "POST",
      body: { contact_email: "integration-expired@test.local" }
    });
    const auth = { Authorization: `Bearer ${register.body.api_key}` };

    const originalTtl = process.env.TOKEN_TTL_SECONDS;
    process.env.TOKEN_TTL_SECONDS = "1";

    try {
      const issue = await jsonRequest(baseUrl, "/v1/tokens/task", {
        method: "POST",
        headers: auth,
        body: {
          request_id: "req_expired_token_case",
          seller_id: "seller_foxlab",
          subagent_id: "foxlab.text.classifier.v1"
        }
      });
      expect(issue.status).toBe(201);

      await new Promise((resolve) => setTimeout(resolve, 1200));

      const sellerAuth = {
        Authorization: `Bearer ${state.bootstrap.sellers.find((item) => item.seller_id === "seller_foxlab").api_key}`
      };
      const introspect = await jsonRequest(baseUrl, "/v1/tokens/introspect", {
        method: "POST",
        headers: sellerAuth,
        body: { task_token: issue.body.task_token }
      });
      expect(introspect.status).toBe(200);
      expect(introspect.body.active).toBe(false);
      expect(introspect.body.error).toBe("AUTH_TOKEN_EXPIRED");
    } finally {
      if (originalTtl === undefined) {
        delete process.env.TOKEN_TTL_SECONDS;
      } else {
        process.env.TOKEN_TTL_SECONDS = originalTtl;
      }
    }
  });

  it("rejects protected endpoints with invalid api key", async () => {
    const badAuth = { Authorization: "Bearer sk_test_invalid_key" };

    const endpoints = [
      { method: "POST", path: "/v1/tokens/task", body: { request_id: "req_bad_1" } },
      { method: "POST", path: "/v1/tokens/introspect", body: { token: "x" } },
      { method: "POST", path: "/v1/requests/req_bad_1/delivery-meta", body: {} },
      { method: "POST", path: "/v1/metrics/events", body: { event_name: "x", source: "test" } },
      { method: "GET", path: "/v1/metrics/summary" },
      { method: "POST", path: "/v1/requests/req_bad_1/ack", body: {} },
      { method: "GET", path: "/v1/requests/req_bad_1/events" },
      { method: "POST", path: "/v1/sellers/seller_foxlab/heartbeat", body: { status: "healthy" } }
    ];

    for (const endpoint of endpoints) {
      const response = await jsonRequest(baseUrl, endpoint.path, {
        method: endpoint.method,
        headers: badAuth,
        body: endpoint.body
      });
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(response.body.error).toBe("AUTH_UNAUTHORIZED");
    }
  });
});
