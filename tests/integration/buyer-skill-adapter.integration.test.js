import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createBuyerSkillAdapterServer } from "../../apps/buyer-skill-adapter/src/server.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

function createFakeBuyerControllerServer() {
  return http.createServer(async (req, res) => {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const pathname = url.pathname;

    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (method === "GET" && pathname === "/controller/catalog/subagents") {
      send(200, {
        items: [
          {
            seller_id: "seller_local_demo",
            subagent_id: "local.summary.v1",
            display_name: "Local Summary Example",
            task_types: ["text_summarize"],
            capabilities: ["text.summarize"],
            tags: ["local", "example", "demo"],
            seller_public_key_pem: "pem"
          }
        ]
      });
      return;
    }

    if (method === "POST" && pathname === "/controller/remote-requests") {
      send(201, {
        request_id: "req_skill_1",
        request: {
          request_id: "req_skill_1",
          seller_id: "seller_local_demo",
          subagent_id: "local.summary.v1",
          status: "SENT"
        }
      });
      return;
    }

    if (method === "GET" && pathname === "/controller/requests/req_skill_1") {
      send(200, {
        request_id: "req_skill_1",
        seller_id: "seller_local_demo",
        subagent_id: "local.summary.v1",
        status: "SUCCEEDED"
      });
      return;
    }

    if (method === "GET" && pathname === "/controller/requests/req_skill_1/result") {
      send(200, {
        available: true,
        result_package: {
          status: "ok",
          seller_id: "seller_local_demo",
          subagent_id: "local.summary.v1",
          output: {
            summary: "skill adapter ok"
          }
        }
      });
      return;
    }

    send(404, { error: { code: "NOT_FOUND", message: "not found" } });
  });
}

describe("buyer skill adapter integration", () => {
  let buyerServer;
  let skillServer;

  afterEach(async () => {
    delete process.env.BUYER_CONTROLLER_BASE_URL;
    if (skillServer) {
      await closeServer(skillServer);
      skillServer = null;
    }
    if (buyerServer) {
      await closeServer(buyerServer);
      buyerServer = null;
    }
  });

  it("maps catalog, invoke, and request lookup through the remote-subagent skill adapter", async () => {
    buyerServer = createFakeBuyerControllerServer();
    const buyerUrl = await listenServer(buyerServer);
    process.env.BUYER_CONTROLLER_BASE_URL = buyerUrl;

    skillServer = createBuyerSkillAdapterServer();
    const skillUrl = await listenServer(skillServer);

    const catalog = await jsonRequest(skillUrl, "/skills/remote-subagent/catalog");
    expect(catalog.status).toBe(200);
    expect(catalog.body.items[0].subagentId).toBe("local.summary.v1");

    const invoked = await jsonRequest(skillUrl, "/skills/remote-subagent/invoke", {
      method: "POST",
      body: {
        subagentId: "local.summary.v1",
        taskType: "text_summarize",
        input: { text: "Summarize me" }
      }
    });
    expect(invoked.status).toBe(200);
    expect(invoked.body.status).toBe("SUCCEEDED");
    expect(invoked.body.result.summary).toBe("skill adapter ok");

    const current = await jsonRequest(skillUrl, "/skills/remote-subagent/requests/req_skill_1");
    expect(current.status).toBe(200);
    expect(current.body.requestId).toBe("req_skill_1");
    expect(current.body.result.summary).toBe("skill adapter ok");
  });
});
