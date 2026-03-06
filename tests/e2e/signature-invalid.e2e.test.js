import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCase } from "../helpers/case-runner.js";
import { jsonRequest, waitFor } from "../helpers/http.js";
import { recordFlowIssue } from "../helpers/flow-step.js";
import { startSystem, stopSystem } from "./system.js";

describe("e2e: signature invalid path", () => {
  let system;

  beforeAll(async () => {
    system = await startSystem();
  });

  afterAll(async () => {
    await stopSystem(system);
  });

  it("marks request as UNVERIFIED when signature is tampered", async () => {
    await runCase({
      caseId: "e2e_signature_invalid",
      name: "tampered signature should be UNVERIFIED",
      fallbackStepId: "H1-F1",
      run: async () => {
        const requestId = `req_sig_invalid_${Date.now()}`;

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
            simulate: "success",
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

        const tampered = {
          ...result.body.result_package,
          output: {
            ...(result.body.result_package.output || {}),
            summary: "tampered"
          }
        };

        await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}/result`, {
          method: "POST",
          body: tampered
        });

        const final = await jsonRequest(system.buyerUrl, `/controller/requests/${requestId}`);
        expect(final.body.status).toBe("UNVERIFIED");
        expect(final.body.last_error_code).toBe("RESULT_SIGNATURE_INVALID");

        recordFlowIssue({
          case_id: "e2e_signature_invalid",
          flow_step_id: "H1-F1",
          severity: "warning",
          error_code: "RESULT_SIGNATURE_INVALID",
          message: "Signature-tampered result path exercised"
        });
      }
    });
  });
});
