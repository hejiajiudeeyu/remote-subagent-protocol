import crypto from "node:crypto";

function nowIso() {
  return new Date().toISOString();
}

function randomInt(maxInclusive) {
  if (maxInclusive <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * (maxInclusive + 1));
}

export class InMemoryEmailTransport {
  constructor(options = {}) {
    this.messages = [];
    this.options = {
      duplicateRate: Number(options.duplicateRate || 0),
      outOfOrderRate: Number(options.outOfOrderRate || 0),
      minDelayMs: Number(options.minDelayMs || 0),
      maxDelayMs: Number(options.maxDelayMs || 0)
    };
  }

  async sendTaskEmail(message) {
    const delayRange = Math.max(this.options.maxDelayMs - this.options.minDelayMs, 0);
    const delayMs = this.options.minDelayMs + randomInt(delayRange);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const record = {
      message_id: message.message_id || `mail_${crypto.randomUUID()}`,
      request_id: message.request_id,
      thread_id: message.thread_id || message.request_id,
      direction: message.direction || "buyer_to_seller",
      payload: message.payload,
      sent_at: nowIso()
    };
    this.messages.push(record);

    if (Math.random() < this.options.duplicateRate) {
      this.messages.push({ ...record, message_id: `dup_${crypto.randomUUID()}` });
    }

    if (Math.random() < this.options.outOfOrderRate && this.messages.length >= 2) {
      const last = this.messages.length - 1;
      const swapWith = randomInt(last - 1);
      const temp = this.messages[last];
      this.messages[last] = this.messages[swapWith];
      this.messages[swapWith] = temp;
    }

    return record;
  }

  async pollThreadReplies({ request_id, direction = "seller_to_buyer", limit = 50 } = {}) {
    return this.messages
      .filter((item) => (!request_id || item.request_id === request_id) && item.direction === direction)
      .slice(0, limit);
  }

  clear() {
    this.messages.length = 0;
  }
}

export async function sendTaskEmail(transport, message) {
  if (!transport || typeof transport.sendTaskEmail !== "function") {
    throw new Error("TRANSPORT_SEND_NOT_AVAILABLE");
  }
  return transport.sendTaskEmail(message);
}

export async function pollThreadReplies(transport, query) {
  if (!transport || typeof transport.pollThreadReplies !== "function") {
    throw new Error("TRANSPORT_POLL_NOT_AVAILABLE");
  }
  return transport.pollThreadReplies(query);
}
