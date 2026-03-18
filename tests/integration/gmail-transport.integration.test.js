import { afterEach, describe, expect, it, vi } from "vitest";

import { createGmailTransportAdapter } from "@delexec/transport-gmail";

describe("gmail transport integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends, polls, acks, and reports health through Gmail API v1", async () => {
    const calls = {
      send: [],
      modify: []
    };
    vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
      if (url === "https://oauth2.googleapis.com/token") {
        return {
          status: 200,
          async text() {
            return JSON.stringify({ access_token: "gmail-token" });
          }
        };
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/buyer%40example.com/messages/send") {
        calls.send.push(JSON.parse(init.body));
        return {
          status: 200,
          async text() {
            return JSON.stringify({ id: "sent_1" });
          }
        };
      }
      if (url.includes("/messages?")) {
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              messages: [{ id: "msg_1", threadId: "thread_1" }]
            });
          }
        };
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/buyer%40example.com/messages/msg_1?format=full") {
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              id: "msg_1",
              threadId: "thread_1",
              payload: {
                headers: [
                  { name: "Subject", value: "[RSP] task.result req_1" },
                  { name: "From", value: "seller@example.com" },
                  { name: "To", value: "buyer@example.com" },
                  { name: "X-RSP-Request-Id", value: "req_1" },
                  { name: "X-RSP-Type", value: "task.result" }
                ],
                parts: [
                  {
                    mimeType: "text/plain",
                    body: {
                      data: Buffer.from(JSON.stringify({ request_id: "req_1", output: { summary: "gmail-ok" } }), "utf8")
                        .toString("base64")
                        .replace(/\+/g, "-")
                        .replace(/\//g, "_")
                        .replace(/=+$/g, "")
                    }
                  },
                  {
                    mimeType: "text/plain",
                    filename: "report.txt",
                    body: {
                      attachmentId: "att_1"
                    }
                  }
                ]
              }
            });
          }
        };
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/buyer%40example.com/messages/msg_1/attachments/att_1") {
        return {
          status: 200,
          async text() {
            return JSON.stringify({
              data: Buffer.from("attachment-body", "utf8")
                .toString("base64")
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/g, "")
            });
          }
        };
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/buyer%40example.com/messages/msg_1/modify") {
        calls.modify.push(JSON.parse(init.body));
        return {
          status: 200,
          async text() {
            return JSON.stringify({ id: "msg_1" });
          }
        };
      }
      if (url === "https://gmail.googleapis.com/gmail/v1/users/buyer%40example.com/profile") {
        return {
          status: 200,
          async text() {
            return JSON.stringify({ emailAddress: "buyer@example.com" });
          }
        };
      }
      throw new Error(`unexpected_fetch:${url}`);
    }));

    const transport = createGmailTransportAdapter({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      user: "buyer@example.com",
      sender: "buyer@example.com",
      receiver: "seller@example.com"
    });

    const sent = await transport.send({
      request_id: "req_1",
      type: "task.requested",
      body_text: JSON.stringify({ request_id: "req_1", text: "hello" })
    });
    expect(sent.request_id).toBe("req_1");
    expect(calls.send).toHaveLength(1);
    expect(typeof calls.send[0].raw).toBe("string");

    const polled = await transport.poll({ limit: 10 });
    expect(polled.items).toHaveLength(1);
    expect(polled.items[0].request_id).toBe("req_1");
    expect(polled.items[0].attachments[0].name).toBe("report.txt");

    const acked = await transport.ack("msg_1");
    expect(acked.acked).toBe(true);
    expect(calls.modify[0].removeLabelIds).toContain("UNREAD");

    const health = await transport.health();
    expect(health.ok).toBe(true);
    expect(health.version).toBe("gmail/v1");
  });
});
