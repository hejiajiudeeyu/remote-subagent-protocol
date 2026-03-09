import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@croc/platform-api";
import { createOpsSupervisorServer } from "../../apps/ops/src/supervisor.js";
import { runCase } from "../helpers/case-runner.js";
import { closeServer, jsonRequest, listenServer, waitFor } from "../helpers/http.js";

describe("e2e: ops supervisor path", () => {
  let opsHome;
  let platformState;
  let platformServer;
  let platformUrl;
  let supervisor;
  let supervisorUrl;

  beforeAll(async () => {
    opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-e2e-"));
    process.env.CROC_OPS_HOME = opsHome;
    process.env.OPS_PORT_SUPERVISOR = String(28000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(29000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(30000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(31000 + Math.floor(Math.random() * 1000));

    platformState = createPlatformState();
    platformServer = createPlatformServer({ serviceName: "platform-api-ops-e2e", state: platformState });
    platformUrl = await listenServer(platformServer);
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();
  });

  afterAll(async () => {
    await supervisor.stopManagedServices();
    await closeServer(supervisor);
    await closeServer(platformServer);
    fs.rmSync(opsHome, { recursive: true, force: true });
    delete process.env.CROC_OPS_HOME;
    delete process.env.PLATFORM_API_BASE_URL;
    delete process.env.OPS_PORT_SUPERVISOR;
    delete process.env.OPS_PORT_RELAY;
    delete process.env.OPS_PORT_BUYER;
    delete process.env.OPS_PORT_SELLER;
  });

  it("completes request via setup -> register buyer -> submit review -> enable seller", async () => {
    await runCase({
      caseId: "e2e_ops_supervisor_success",
      name: "ops supervisor path should dispatch through unified local client",
      fallbackStepId: "H2-S1",
      run: async () => {
        const buyer = await jsonRequest(supervisorUrl, "/auth/register-buyer", {
          method: "POST",
          body: { contact_email: "ops-e2e@test.local" }
        });
        expect(buyer.status).toBe(201);

        const addSubagent = await jsonRequest(supervisorUrl, "/seller/subagents", {
          method: "POST",
          body: {
            subagent_id: "ops.process.echo.v1",
            display_name: "Ops Process Echo",
            task_types: ["text_classify"],
            capabilities: ["text.classify"],
            tags: ["ops", "e2e"],
            adapter_type: "process",
            adapter: {
              cmd: `${process.execPath} -e "process.stdin.resume();process.stdin.on('data',()=>{});process.stdin.on('end',()=>process.stdout.write(JSON.stringify({status:'ok',output:{summary:'ops supervisor ok'},schema_valid:true,usage:{tokens_in:0,tokens_out:0}})))"`
            }
          }
        });
        expect(addSubagent.status).toBe(201);

        const review = await jsonRequest(supervisorUrl, "/seller/submit-review", {
          method: "POST",
          body: { seller_id: "seller_ops_e2e", display_name: "Ops E2E Seller" }
        });
        expect(review.status).toBe(201);

        const enable = await jsonRequest(supervisorUrl, "/seller/enable", {
          method: "POST",
          body: { seller_id: "seller_ops_e2e", display_name: "Ops E2E Seller" }
        });
        expect(enable.status).toBe(200);

        const adminHeader = { Authorization: `Bearer ${platformState.adminApiKey}` };
        const approveSeller = await jsonRequest(platformUrl, "/v1/admin/sellers/seller_ops_e2e/approve", {
          method: "POST",
          headers: adminHeader,
          body: { reason: "e2e approve seller" }
        });
        expect(approveSeller.status).toBe(200);

        const approveSubagent = await jsonRequest(platformUrl, "/v1/admin/subagents/ops.process.echo.v1/approve", {
          method: "POST",
          headers: adminHeader,
          body: { reason: "e2e approve subagent" }
        });
        expect(approveSubagent.status).toBe(200);

        const selected = await waitFor(async () => {
          const catalog = await jsonRequest(supervisorUrl, "/catalog/subagents?capability=text.classify");
          const item = catalog.body?.items?.find((entry) => entry.subagent_id === "ops.process.echo.v1");
          if (!item) {
            throw new Error("catalog_not_ready");
          }
          return item;
        });

        const started = await jsonRequest(supervisorUrl, "/requests", {
          method: "POST",
          body: {
            request_id: `req_ops_supervisor_${Date.now()}`,
            seller_id: selected.seller_id,
            subagent_id: selected.subagent_id,
            expected_signer_public_key_pem: selected.seller_public_key_pem,
            task_type: "text_classify",
            input: { text: "ops supervisor path" },
            payload: { text: "ops supervisor path" },
            output_schema: {
              type: "object",
              properties: {
                summary: { type: "string" }
              }
            }
          }
        });
        expect(started.status).toBe(201);

        const requestId = started.body.request_id;
        const final = await waitFor(async () => {
          const current = await jsonRequest(supervisorUrl, `/requests/${requestId}`);
          if (!["SUCCEEDED", "UNVERIFIED", "FAILED"].includes(current.body.status)) {
            throw new Error("result_not_ready");
          }
          return current;
        }, { timeoutMs: 5000, intervalMs: 100 });
        expect(["SUCCEEDED", "UNVERIFIED", "FAILED"]).toContain(final.body.status);

        const result = await jsonRequest(supervisorUrl, `/requests/${requestId}/result`);
        expect(result.status).toBe(200);
        expect(result.body.available).toBe(true);
        expect(result.body.result_package.output.summary).toBe("ops supervisor ok");
      }
    });
  });
});
