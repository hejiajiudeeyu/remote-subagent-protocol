import crypto from "node:crypto";

export const RSP_EMAIL_SUBJECT_PREFIX = "[RSP]";

function nowIso() {
  return new Date().toISOString();
}

function randomInt(maxInclusive) {
  if (maxInclusive <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * (maxInclusive + 1));
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function normalizeAttachments(attachments = []) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment, index) => {
    const contentBase64 = Buffer.isBuffer(attachment?.content)
      ? attachment.content.toString("base64")
      : attachment?.content_base64 || Buffer.from(String(attachment?.content || ""), "utf8").toString("base64");
    const byteSize = Buffer.from(contentBase64 || "", "base64").length;
    return {
      attachment_id: attachment?.attachment_id || `att_${index}_${crypto.randomUUID()}`,
      name: attachment?.name || `attachment-${index + 1}.bin`,
      media_type: attachment?.media_type || "application/octet-stream",
      content_base64: contentBase64,
      byte_size: Number.isFinite(Number(attachment?.byte_size)) ? Number(attachment.byte_size) : byteSize
    };
  });
}

export function normalizeEnvelope(envelope = {}) {
  const base = deepClone(envelope);
  const bodyText =
    typeof envelope.body_text === "string"
      ? envelope.body_text
      : typeof envelope.result_package === "object"
        ? JSON.stringify(envelope.result_package)
        : typeof envelope.payload === "string"
          ? envelope.payload
          : envelope.payload?.body_text || "";

  const to =
    envelope.to ||
    envelope.address ||
    envelope.receiver ||
    (envelope.direction === "seller_to_buyer" ? "buyer-controller" : "seller-controller");
  const from =
    envelope.from ||
    envelope.sender ||
    (envelope.direction === "seller_to_buyer" ? "seller-controller" : "buyer-controller");

  const payload =
    envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
      ? deepClone(envelope.payload)
      : envelope.payload;

  return {
    ...base,
    message_id: envelope.message_id || `mail_${crypto.randomUUID()}`,
    request_id: envelope.request_id || payload?.request_id || envelope.result_package?.request_id || null,
    thread_id: envelope.thread_id || envelope.thread_hint || envelope.request_id || `thread_${crypto.randomUUID()}`,
    thread_hint: envelope.thread_hint || envelope.thread_id || envelope.request_id || null,
    from,
    to,
    type: envelope.type || payload?.type || "email.message",
    direction: envelope.direction || null,
    body_text: bodyText,
    payload,
    result_package: envelope.result_package ? deepClone(envelope.result_package) : null,
    attachments: normalizeAttachments(envelope.attachments || payload?.attachments || []),
    sent_at: nowIso()
  };
}

export function buildEmailSubject(envelope = {}) {
  const normalized = normalizeEnvelope(envelope);
  const type = normalized.type || "message";
  const requestId = normalized.request_id || normalized.thread_id || normalized.message_id;
  return `${RSP_EMAIL_SUBJECT_PREFIX} ${type} ${requestId}`;
}

export function isRspEmailSubject(subject) {
  return typeof subject === "string" && subject.startsWith(`${RSP_EMAIL_SUBJECT_PREFIX} `);
}

export function buildRspHeaders(envelope = {}) {
  const normalized = normalizeEnvelope(envelope);
  return {
    "X-RSP-Transport": "1",
    "X-RSP-Request-Id": normalized.request_id || "",
    "X-RSP-Thread-Id": normalized.thread_id || "",
    "X-RSP-Message-Id": normalized.message_id || "",
    "X-RSP-Type": normalized.type || "",
    "X-RSP-From": normalized.from || "",
    "X-RSP-To": normalized.to || ""
  };
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

  async send(envelope) {
    const delayRange = Math.max(this.options.maxDelayMs - this.options.minDelayMs, 0);
    const delayMs = this.options.minDelayMs + randomInt(delayRange);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const record = normalizeEnvelope(envelope);
    this.messages.push(record);

    if (Math.random() < this.options.duplicateRate) {
      this.messages.push({ ...deepClone(record), message_id: `dup_${crypto.randomUUID()}` });
    }

    if (Math.random() < this.options.outOfOrderRate && this.messages.length >= 2) {
      const last = this.messages.length - 1;
      const swapWith = randomInt(last - 1);
      const temp = this.messages[last];
      this.messages[last] = this.messages[swapWith];
      this.messages[swapWith] = temp;
    }

    return deepClone(record);
  }

  async poll({ receiver, limit = 50 } = {}) {
    const items = this.messages
      .filter((item) => !receiver || item.to === receiver)
      .slice(0, limit)
      .map((item) => deepClone(item));
    return { items };
  }

  async ack(messageId, { receiver } = {}) {
    const index = this.messages.findIndex((item) => item.message_id === messageId && (!receiver || item.to === receiver));
    if (index === -1) {
      return { acked: false };
    }
    this.messages.splice(index, 1);
    return { acked: true };
  }

  async sendTaskEmail(message) {
    return this.send(message);
  }

  async pollThreadReplies({ request_id, direction = "seller_to_buyer", limit = 50 } = {}) {
    return this.messages
      .filter((item) => (!request_id || item.request_id === request_id) && item.direction === direction)
      .slice(0, limit)
      .map((item) => deepClone(item));
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
