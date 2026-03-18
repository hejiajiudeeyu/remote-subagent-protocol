import {
  buildEmailSubject,
  buildRspHeaders,
  isRspEmailSubject,
  normalizeEnvelope
} from "@delexec/transport-email";

function base64ToUtf8(value) {
  return Buffer.from(value || "", "base64").toString("utf8");
}

async function request(baseUrl, pathname, { method = "GET", headers = {}, body, parse = "json" } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers,
    body
  });
  if (parse === "buffer") {
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer())
    };
  }
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null
  };
}

function authHeaders(accessToken, extra = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...extra
  };
}

async function fetchMessageAttachments(baseUrl, account, accessToken, attachments = []) {
  const results = [];
  for (const attachment of attachments) {
    const response = await request(baseUrl, `/v1/account/${encodeURIComponent(account)}/attachment/${encodeURIComponent(attachment.id)}`, {
      headers: authHeaders(accessToken),
      parse: "buffer"
    });
    if (response.status !== 200) {
      throw new Error(`emailengine_attachment_fetch_failed:${response.status}`);
    }
    const content = response.body;
    results.push({
      attachment_id: attachment.id,
      name: attachment.filename || attachment.name || `attachment-${results.length + 1}.bin`,
      media_type: attachment.contentType || attachment.mimeType || "application/octet-stream",
      content_base64: content.toString("base64"),
      byte_size: content.length
    });
  }
  return results;
}

async function loadMessage(baseUrl, account, accessToken, message) {
  const response = await request(baseUrl, `/v1/account/${encodeURIComponent(account)}/message/${encodeURIComponent(message.id)}?textType=*`, {
    headers: authHeaders(accessToken)
  });
  if (response.status !== 200) {
    throw new Error(`emailengine_message_fetch_failed:${response.status}`);
  }
  const body = response.body || {};
  const attachments = await fetchMessageAttachments(baseUrl, account, accessToken, body.attachments || []);
  const textBody = Array.isArray(body.text?.plain)
    ? body.text.plain.join("\n")
    : typeof body.text?.plain === "string"
      ? body.text.plain
      : "";
  let payload = null;
  try {
    payload = textBody ? JSON.parse(textBody) : null;
  } catch {
    payload = null;
  }
  return normalizeEnvelope({
    message_id: body.messageId || message.messageId || message.id || null,
    thread_id: body.threadId || message.threadId || null,
    thread_hint: body.threadId || message.threadId || null,
    request_id: body.headers?.["x-rsp-request-id"] || body.headers?.["X-RSP-Request-Id"] || payload?.request_id || null,
    from: body.from?.address || body.from?.[0]?.address || null,
    to: body.to?.[0]?.address || body.to?.address || null,
    type: body.headers?.["x-rsp-type"] || body.headers?.["X-RSP-Type"] || payload?.type || "email.message",
    body_text: textBody,
    payload,
    attachments
  });
}

export function createEmailEngineTransportAdapter({
  baseUrl,
  account,
  accessToken,
  receiver = account,
  sender = account,
  pageSize = 20
}) {
  if (!baseUrl) {
    throw new Error("emailengine_base_url_required");
  }
  if (!account) {
    throw new Error("emailengine_account_required");
  }
  if (!accessToken) {
    throw new Error("emailengine_access_token_required");
  }

  return {
    async send(envelope) {
      const normalized = normalizeEnvelope({
        ...envelope,
        from: envelope.from || sender,
        to: envelope.to || receiver
      });
      const response = await request(baseUrl, `/v1/account/${encodeURIComponent(account)}/submit`, {
        method: "POST",
        headers: authHeaders(accessToken, {
          "content-type": "application/json; charset=utf-8"
        }),
        body: JSON.stringify({
          from: normalized.from,
          to: [normalized.to],
          subject: buildEmailSubject(normalized),
          text: normalized.body_text,
          headers: buildRspHeaders(normalized),
          attachments: normalized.attachments.map((attachment) => ({
            filename: attachment.name,
            contentType: attachment.media_type,
            content: attachment.content_base64,
            encoding: "base64"
          }))
        })
      });
      if (response.status !== 200 && response.status !== 202) {
        throw new Error(`emailengine_send_failed:${response.status}`);
      }
      return normalized;
    },

    async poll({ limit = 10 } = {}) {
      const response = await request(baseUrl, `/v1/account/${encodeURIComponent(account)}/search?path=INBOX`, {
        method: "POST",
        headers: authHeaders(accessToken, {
          "content-type": "application/json; charset=utf-8"
        }),
        body: JSON.stringify({
          page: 0,
          pageSize: Math.max(limit, pageSize),
          search: {
            unseen: true
          }
        })
      });
      if (response.status !== 200) {
        throw new Error(`emailengine_poll_failed:${response.status}`);
      }
      const messages = Array.isArray(response.body?.messages) ? response.body.messages : [];
      const items = [];
      for (const message of messages) {
        if (!isRspEmailSubject(message.subject || "")) {
          continue;
        }
        items.push(await loadMessage(baseUrl, account, accessToken, message));
        if (items.length >= limit) {
          break;
        }
      }
      return { items };
    },

    async ack(messageId) {
      const response = await request(baseUrl, `/v1/account/${encodeURIComponent(account)}/message/${encodeURIComponent(messageId)}`, {
        method: "PUT",
        headers: authHeaders(accessToken, {
          "content-type": "application/json; charset=utf-8"
        }),
        body: JSON.stringify({
          flags: {
            add: ["\\Seen"]
          }
        })
      });
      if (response.status !== 200) {
        throw new Error(`emailengine_ack_failed:${response.status}`);
      }
      return { acked: true };
    },

    async health() {
      const response = await request(baseUrl, `/v1/account/${encodeURIComponent(account)}`, {
        headers: authHeaders(accessToken)
      });
      if (response.status !== 200) {
        throw new Error(`emailengine_health_failed:${response.status}`);
      }
      return {
        ok: true,
        provider: "emailengine",
        version: "API v1",
        account
      };
    }
  };
}
