import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCase } from "../helpers/case-runner.js";
import { jsonRequest, waitFor } from "../helpers/http.js";
import { startSystem, stopSystem } from "./system.js";

describe("e2e: success path", () => {
  let system;

  beforeAll(async () => {
    system = await startSystem();
  });

  afterAll(async () => {
    await stopSystem(system);
  });

  it("completes request with SUCCEEDED status", async () => {
    await runCase({
      caseId: "e2e_success",
      name: "success path should end at SUCCEEDED",
      fallbackStepId: "H2-S1",
      run: async () => {
        const requestId = `req_success_${Date.now()}`;

        const registered = await jsonRequest(system.platformUrl, "/v1/users/register", {
          method: "POST",
          body: { contact_email: "e2e-success@test.local" }
        });
        expect(registered.status).toBe(201);

        const authHeader = { Authorization: `Bearer ${registered.body.api_key}` };

        const catalog = await jsonRequest(system.platformUrl, "/v1/catalog/subagents?status=active");
        expect(catalog.status).toBe(200);
        expect(catalog.body.items.length).toBeGreaterThan(0);

        const selected = catalog.body.items[0];

        const tokenIssued = await jsonRequest(system.platformUrl, "/v1/tokens/task", {
          method: "POST",
          headers: authHeader,
          body: {
            request_id: requestId,
            seller_id: selected.seller_id,
            subagent_id: selected.subagent_id
          }
        });
        expect(tokenIssued.status).toBe(201);

        await jsonRequest(system.buyerUrl, "/controller/requests", {
          method: "POST",
          body: {
            request_id: requestId,
            seller_id: selected.seller_id,
            subagent_id: selected.subagent_id,
            expected_signer_public_key_pem: selected.seller_public_key_pem,
            soft_timeout_s: 5,
            hard_timeout_s: 10
          }
        });

        const deliveryMeta = await jsonRequest(system.platformUrl, `/v1/requests/${requestId}/delivery-meta`, {
          method: "POST",
          headers: authHeader,
          body: {
            seller_id: selected.seller_id,
            subagent_id: selected.subagent_id,
            task_token: tokenIssued.body.task_token
          }
        });
        expect(deliveryMeta.status).toBe(200);

        await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}/dispatch`, {
          method: "POST",
          body: {
            task_token: tokenIssued.body.task_token,
            to: selected.seller_id,
            simulate: "success",
            delay_ms: 30
          }
        });

        const pulled = await jsonRequest(system.sellerUrl, "/controller/inbox/pull", {
          method: "POST",
          body: {}
        });
        expect(pulled.status).toBe(200);
        expect(pulled.body.accepted.length).toBe(1);

        await waitFor(async () => {
          const events = await jsonRequest(system.platformUrl, `/v1/requests/${requestId}/events`, {
            headers: authHeader
          });
          if (!events.body.events.some((event) => event.event_type === "ACKED")) {
            throw new Error("ack_not_ready");
          }
          return events;
        });

        const inbox = await waitFor(async () => {
          const polled = await jsonRequest(system.buyerUrl, "/controller/inbox/pull", {
            method: "POST",
            body: {}
          });
          if (polled.status !== 200 || polled.body.accepted.length !== 1) {
            throw new Error("buyer_inbox_not_ready");
          }
          return polled;
        });
        expect(inbox.body.accepted[0].request_id).toBe(requestId);

        const final = await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}`);
        expect(final.body.status).toBe("SUCCEEDED");
      }
    });
  });
});
