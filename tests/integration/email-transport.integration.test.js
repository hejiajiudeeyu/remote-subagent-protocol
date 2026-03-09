import { describe, expect, it } from "vitest";

import {
  InMemoryEmailTransport,
  pollThreadReplies,
  sendTaskEmail
} from "@croc/transport-email";

describe("email transport integration", () => {
  it("sends and polls by request and direction", async () => {
    const transport = new InMemoryEmailTransport({ minDelayMs: 0, maxDelayMs: 1 });

    await sendTaskEmail(transport, {
      request_id: "req_mail_1",
      thread_id: "thread_1",
      direction: "buyer_to_seller",
      payload: { type: "task", body: "hello" }
    });

    await sendTaskEmail(transport, {
      request_id: "req_mail_1",
      thread_id: "thread_1",
      direction: "seller_to_buyer",
      payload: { type: "result", body: "ok" }
    });

    const replies = await pollThreadReplies(transport, {
      request_id: "req_mail_1",
      direction: "seller_to_buyer"
    });

    expect(replies.length).toBe(1);
    expect(replies[0].payload.type).toBe("result");
  });

  it("can simulate duplicates", async () => {
    const transport = new InMemoryEmailTransport({ duplicateRate: 1 });

    await sendTaskEmail(transport, {
      request_id: "req_mail_dup_1",
      direction: "seller_to_buyer",
      payload: { type: "result", body: "dup" }
    });

    const replies = await pollThreadReplies(transport, {
      request_id: "req_mail_dup_1",
      direction: "seller_to_buyer"
    });

    expect(replies.length).toBeGreaterThanOrEqual(2);
  });

  it("throws on missing transport interface", async () => {
    await expect(sendTaskEmail({}, { request_id: "req_x" })).rejects.toThrow("TRANSPORT_SEND_NOT_AVAILABLE");
    await expect(pollThreadReplies({}, { request_id: "req_x" })).rejects.toThrow("TRANSPORT_POLL_NOT_AVAILABLE");
  });
});
