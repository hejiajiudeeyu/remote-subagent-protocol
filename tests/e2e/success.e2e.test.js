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

        const registered = await jsonRequest(system.buyerUrl, "/controller/register", {
          method: "POST",
          body: { contact_email: "e2e-success@test.local" }
        });
        expect(registered.status).toBe(201);

        const authHeader = { "X-Platform-Api-Key": registered.body.api_key };

        const catalog = await jsonRequest(system.buyerUrl, "/controller/catalog/subagents?status=enabled", {
          headers: authHeader
        });
        expect(catalog.status).toBe(200);
        expect(catalog.body.items.length).toBeGreaterThan(0);

        const selected = catalog.body.items[0];

        const started = await jsonRequest(system.buyerUrl, "/controller/remote-requests", {
          method: "POST",
          headers: authHeader,
          body: {
            request_id: requestId,
            seller_id: selected.seller_id,
            subagent_id: selected.subagent_id,
            expected_signer_public_key_pem: selected.seller_public_key_pem,
            simulate: "success",
            delay_ms: 30,
            soft_timeout_s: 5,
            hard_timeout_s: 10
          }
        });
        expect(started.status).toBe(201);

        await waitFor(async () => {
          const current = await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}`);
          if (current.body.status !== "ACKED" && current.body.status !== "SUCCEEDED") {
            throw new Error("ack_not_ready");
          }
          return current;
        });

        const final = await waitFor(async () => {
          const current = await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}`);
          if (current.body.status !== "SUCCEEDED") {
            throw new Error("result_not_ready");
          }
          return current;
        });
        expect(final.body.status).toBe("SUCCEEDED");
      }
    });
  });
});
