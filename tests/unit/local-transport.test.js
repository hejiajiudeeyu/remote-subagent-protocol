import { describe, expect, it } from "vitest";

import { createLocalTransportHub, createLocalTransportAdapter } from "@delexec/transport-local";

describe("createLocalTransportAdapter", () => {
  it("throws when hub is missing", () => {
    expect(() => createLocalTransportAdapter({ receiver: "test" })).toThrow("local_transport_hub_required");
  });

  it("throws when receiver is missing", () => {
    const hub = createLocalTransportHub();
    expect(() => createLocalTransportAdapter({ hub })).toThrow("local_transport_receiver_required");
  });
});

describe("local transport send", () => {
  it("assigns message_id and queued_at when not provided", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "seller_1" });

    const msg = await adapter.send({ payload: "test" });
    expect(msg.message_id).toMatch(/^msg_/);
    expect(msg.queued_at).toBeDefined();
  });

  it("preserves provided message_id and queued_at", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "seller_1" });

    const msg = await adapter.send({
      message_id: "custom_id",
      queued_at: "2026-01-01T00:00:00Z",
      payload: "test"
    });
    expect(msg.message_id).toBe("custom_id");
    expect(msg.queued_at).toBe("2026-01-01T00:00:00Z");
  });

  it("routes to envelope.to when present", async () => {
    const hub = createLocalTransportHub();
    const senderAdapter = createLocalTransportAdapter({ hub, receiver: "buyer_1" });
    const sellerAdapter = createLocalTransportAdapter({ hub, receiver: "seller_1" });

    await senderAdapter.send({ to: "seller_1", payload: "routed" });

    const { items } = await sellerAdapter.poll();
    expect(items).toHaveLength(1);
    expect(items[0].payload).toBe("routed");
  });

  it("routes to envelope.seller_id when to is not present", async () => {
    const hub = createLocalTransportHub();
    const senderAdapter = createLocalTransportAdapter({ hub, receiver: "buyer_1" });
    const sellerAdapter = createLocalTransportAdapter({ hub, receiver: "seller_1" });

    await senderAdapter.send({ seller_id: "seller_1", payload: "by-seller-id" });

    const { items } = await sellerAdapter.poll();
    expect(items).toHaveLength(1);
  });

  it("falls back to adapter receiver when no routing info in envelope", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "self" });

    await adapter.send({ payload: "self-route" });

    const { items } = await adapter.poll();
    expect(items).toHaveLength(1);
  });
});

describe("local transport resolveReceiver via send", () => {
  it("resolves local://relay/seller_id to seller_id", async () => {
    const hub = createLocalTransportHub();
    const senderAdapter = createLocalTransportAdapter({ hub, receiver: "buyer" });
    const sellerAdapter = createLocalTransportAdapter({ hub, receiver: "seller_x" });

    await senderAdapter.send({ to: "local://relay/seller_x", payload: "relay-route" });

    const { items } = await sellerAdapter.poll();
    expect(items).toHaveLength(1);
    expect(items[0].payload).toBe("relay-route");
  });

  it("resolves local://seller_y to seller_y", async () => {
    const hub = createLocalTransportHub();
    const senderAdapter = createLocalTransportAdapter({ hub, receiver: "buyer" });
    const sellerAdapter = createLocalTransportAdapter({ hub, receiver: "seller_y" });

    await senderAdapter.send({ to: "local://seller_y", payload: "direct" });

    const { items } = await sellerAdapter.poll();
    expect(items).toHaveLength(1);
  });

  it("passes through non-local:// targets as-is", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "raw_target" });

    await adapter.send({ to: "raw_target", payload: "passthrough" });

    const { items } = await adapter.poll();
    expect(items).toHaveLength(1);
  });

  it("passes through null target using adapter receiver", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "fallback" });

    await adapter.send({ to: null, payload: "null-target" });

    const { items } = await adapter.poll({ receiver: "fallback" });
    expect(items).toHaveLength(1);
  });
});

describe("local transport poll", () => {
  it("respects limit parameter", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    await adapter.send({ payload: "a" });
    await adapter.send({ payload: "b" });
    await adapter.send({ payload: "c" });

    const { items } = await adapter.poll({ limit: 2 });
    expect(items).toHaveLength(2);
  });

  it("returns empty items for empty queue", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "empty" });

    const { items } = await adapter.poll();
    expect(items).toEqual([]);
  });

  it("supports override receiver", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "default" });

    await adapter.send({ to: "other", payload: "msg" });

    const { items } = await adapter.poll({ receiver: "other" });
    expect(items).toHaveLength(1);
  });
});

describe("local transport ack", () => {
  it("returns acked:true and removes message", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    const msg = await adapter.send({ payload: "to-ack" });
    const result = await adapter.ack(msg.message_id);
    expect(result.acked).toBe(true);

    const { items } = await adapter.poll();
    expect(items).toHaveLength(0);
  });

  it("returns acked:false for non-existent message_id", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    const result = await adapter.ack("non_existent_id");
    expect(result.acked).toBe(false);
  });

  it("returns acked:false when acking already acked message", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    const msg = await adapter.send({ payload: "double-ack" });
    await adapter.ack(msg.message_id);
    const result = await adapter.ack(msg.message_id);
    expect(result.acked).toBe(false);
  });

  it("supports override receiver for ack", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "default" });

    await adapter.send({ to: "other", payload: "msg" });
    const { items } = await adapter.poll({ receiver: "other" });

    const result = await adapter.ack(items[0].message_id, { receiver: "other" });
    expect(result.acked).toBe(true);
  });
});

describe("local transport peek", () => {
  it("returns all messages without filtering when no thread_id", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    await adapter.send({ payload: "a" });
    await adapter.send({ payload: "b" });

    const { items } = await adapter.peek();
    expect(items).toHaveLength(2);
  });

  it("filters by thread_id", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    await adapter.send({ thread_id: "t1", payload: "a" });
    await adapter.send({ thread_id: "t2", payload: "b" });
    await adapter.send({ thread_id: "t1", payload: "c" });

    const { items } = await adapter.peek({ thread_id: "t1" });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.thread_id === "t1")).toBe(true);
  });

  it("does not modify queue (non-destructive)", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    await adapter.send({ payload: "peek-me" });
    await adapter.peek();
    await adapter.peek();

    const { items } = await adapter.poll();
    expect(items).toHaveLength(1);
  });
});

describe("local transport health", () => {
  it("returns health status with queue depth", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "r" });

    await adapter.send({ payload: "a" });
    await adapter.send({ payload: "b" });

    const health = await adapter.health();
    expect(health.ok).toBe(true);
    expect(health.receiver).toBe("r");
    expect(health.queue_depth).toBe(2);
  });

  it("returns zero queue depth for empty queue", async () => {
    const hub = createLocalTransportHub();
    const adapter = createLocalTransportAdapter({ hub, receiver: "empty" });

    const health = await adapter.health();
    expect(health.queue_depth).toBe(0);
  });
});

describe("local transport hub isolation", () => {
  it("isolates queues between different receivers", async () => {
    const hub = createLocalTransportHub();
    const adapter1 = createLocalTransportAdapter({ hub, receiver: "r1" });
    const adapter2 = createLocalTransportAdapter({ hub, receiver: "r2" });

    await adapter1.send({ to: "r1", payload: "for-r1" });
    await adapter1.send({ to: "r2", payload: "for-r2" });

    const r1Items = await adapter1.poll();
    const r2Items = await adapter2.poll();

    expect(r1Items.items).toHaveLength(1);
    expect(r1Items.items[0].payload).toBe("for-r1");
    expect(r2Items.items).toHaveLength(1);
    expect(r2Items.items[0].payload).toBe("for-r2");
  });
});
