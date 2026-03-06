import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCase } from "../helpers/case-runner.js";
import { jsonRequest, waitFor } from "../helpers/http.js";
import { recordFlowIssue } from "../helpers/flow-step.js";
import { startSystem, stopSystem } from "./system.js";

describe("e2e: token expired path", () => {
  let system;

  beforeAll(async () => {
    system = await startSystem();
  });

  afterAll(async () => {
    await stopSystem(system);
  });

  it("returns FAILED with AUTH_TOKEN_EXPIRED", async () => {
    await runCase({
      caseId: "e2e_token_expired",
      name: "expired token error package should be accepted as FAILED",
      fallbackStepId: "F1-F1",
      run: async () => {
        const requestId = `req_token_expired_${Date.now()}`;

        await jsonRequest(system.buyerUrl, "/controller/requests", {
          method: "POST",
          body: {
            request_id: requestId,
            seller_id: system.bootstrapSeller.seller_id,
            subagent_id: system.bootstrapSeller.subagent_id,
            expected_signer_public_key_pem: system.bootstrapSeller.signing.publicKeyPem,
            soft_timeout_s: 5,
            hard_timeout_s: 10
          }
        });

        const task = await jsonRequest(system.sellerUrl, "/controller/tasks", {
          method: "POST",
          body: {
            request_id: requestId,
            simulate: "token_expired",
            delay_ms: 30
          }
        });

        const result = await waitFor(async () => {
          const polled = await jsonRequest(system.sellerUrl, `/controller/tasks/${task.body.task_id}/result`);
          if (polled.status !== 200 || polled.body.available !== true) {
            throw new Error("result_not_ready");
          }
          return polled;
        });

        await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}/result`, {
          method: "POST",
          body: result.body.result_package
        });

        const final = await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}`);
        expect(final.body.status).toBe("FAILED");
        expect(final.body.last_error_code).toBe("AUTH_TOKEN_EXPIRED");

        recordFlowIssue({
          case_id: "e2e_token_expired",
          flow_step_id: "F1-F1",
          severity: "warning",
          error_code: "AUTH_TOKEN_EXPIRED",
          message: "Token-expired rejection path exercised"
        });
      }
    });
  });
});
