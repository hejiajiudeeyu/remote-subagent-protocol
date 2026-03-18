import http from "node:http";

import { describe, expect, it } from "vitest";

import { createEmailEngineTransportAdapter } from "@delexec/transport-emailengine";
import { closeServer, listenServer } from "../helpers/http.js";

describe("emailengine transport integration", () => {
  it("sends, polls, acks, and reports health through EmailEngine API v1", async () => {
    const calls = {
      submit: [],
      ack: []
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const body = bodyText ? JSON.parse(bodyText) : null;

      if (req.method === "GET" && url.pathname === "/v1/account/buyer%40example.com") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ account: "buyer@example.com" }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/account/buyer%40example.com/submit") {
        calls.submit.push(body);
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ queued: true }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/account/buyer%40example.com/search") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          messages: [
            {
              id: "mail_1",
              messageId: "mail_1",
              subject: "[RSP] task.result req_1",
              unseen: true,
              threadId: "thread_1"
            }
          ]
        }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/account/buyer%40example.com/message/mail_1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "mail_1",
          messageId: "mail_1",
          threadId: "thread_1",
          from: { address: "seller@example.com" },
          to: [{ address: "buyer@example.com" }],
          headers: {
            "X-RSP-Request-Id": "req_1",
            "X-RSP-Type": "task.result"
          },
          text: {
            plain: JSON.stringify({ request_id: "req_1", status: "ok", output: { summary: "emailengine-ok" } })
          },
          attachments: [
            {
              id: "att_1",
              filename: "report.txt",
              contentType: "text/plain"
            }
          ]
        }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/account/buyer%40example.com/attachment/att_1") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("attachment-body");
        return;
      }
      if (req.method === "PUT" && url.pathname === "/v1/account/buyer%40example.com/message/mail_1") {
        calls.ack.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ updated: true }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });
    const baseUrl = await listenServer(server);
    const transport = createEmailEngineTransportAdapter({
      baseUrl,
      account: "buyer@example.com",
      accessToken: "ee-token",
      sender: "buyer@example.com",
      receiver: "seller@example.com"
    });

    try {
      const sent = await transport.send({
        request_id: "req_1",
        type: "task.requested",
        body_text: JSON.stringify({ request_id: "req_1", text: "hello" })
      });
      expect(sent.request_id).toBe("req_1");
      expect(calls.submit).toHaveLength(1);
      expect(calls.submit[0].headers["X-RSP-Request-Id"]).toBe("req_1");

      const polled = await transport.poll({ limit: 10 });
      expect(polled.items).toHaveLength(1);
      expect(polled.items[0].request_id).toBe("req_1");
      expect(polled.items[0].attachments[0].name).toBe("report.txt");

      const acked = await transport.ack("mail_1");
      expect(acked.acked).toBe(true);
      expect(calls.ack[0].flags.add).toContain("\\Seen");

      const health = await transport.health();
      expect(health.ok).toBe(true);
      expect(health.version).toBe("API v1");
    } finally {
      await closeServer(server);
    }
  });
});
