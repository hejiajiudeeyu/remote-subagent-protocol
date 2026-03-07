import crypto from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

export function createLocalTransportHub() {
  return {
    queues: new Map()
  };
}

function getQueue(hub, receiver) {
  if (!hub.queues.has(receiver)) {
    hub.queues.set(receiver, []);
  }
  return hub.queues.get(receiver);
}

function resolveReceiver(target) {
  if (!target || typeof target !== "string" || !target.startsWith("local://")) {
    return target;
  }

  try {
    const parsed = new URL(target);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (parsed.hostname === "relay" && segments[0]) {
      return segments[0];
    }
    if (segments[0]) {
      return segments[0];
    }
    if (parsed.hostname) {
      return parsed.hostname;
    }
  } catch {
    return target;
  }

  return target;
}

export function createLocalTransportAdapter({ hub, receiver }) {
  if (!hub) {
    throw new Error("local_transport_hub_required");
  }
  if (!receiver) {
    throw new Error("local_transport_receiver_required");
  }

  return {
    async send(envelope) {
      const target = resolveReceiver(envelope.to || envelope.seller_id || receiver);
      const queue = getQueue(hub, target);
      const message = {
        ...envelope,
        message_id: envelope.message_id || `msg_${crypto.randomUUID()}`,
        queued_at: envelope.queued_at || nowIso()
      };
      queue.push(message);
      return message;
    },

    async poll({ limit = 10, receiver: overrideReceiver } = {}) {
      const queue = getQueue(hub, overrideReceiver || receiver);
      return {
        items: queue.slice(0, limit)
      };
    },

    async ack(messageId, { receiver: overrideReceiver } = {}) {
      const queue = getQueue(hub, overrideReceiver || receiver);
      const index = queue.findIndex((item) => item.message_id === messageId);
      if (index >= 0) {
        queue.splice(index, 1);
        return { acked: true };
      }
      return { acked: false };
    },

    async peek({ thread_id, receiver: overrideReceiver } = {}) {
      const queue = getQueue(hub, overrideReceiver || receiver);
      const items = thread_id ? queue.filter((item) => item.thread_id === thread_id) : [...queue];
      return { items };
    },

    async health() {
      const queue = getQueue(hub, receiver);
      return {
        ok: true,
        receiver,
        queue_depth: queue.length
      };
    }
  };
}
