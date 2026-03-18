import {
  buildEmailSubject,
  buildRspHeaders,
  isRspEmailSubject,
  normalizeEnvelope,
  RSP_EMAIL_SUBJECT_PREFIX
} from "@delexec/transport-email";

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, "base64");
}

async function request(url, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    body
  });
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

async function refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken }) {
  const response = await request(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  if (response.status !== 200 || !response.body?.access_token) {
    throw new Error(`gmail_token_refresh_failed:${response.status}`);
  }
  return response.body.access_token;
}

function buildMimeMessage(envelope) {
  const normalized = normalizeEnvelope(envelope);
  const headers = buildRspHeaders(normalized);
  const headerLines = [
    `From: ${normalized.from}`,
    `To: ${normalized.to}`,
    `Subject: ${buildEmailSubject(normalized)}`,
    "MIME-Version: 1.0"
  ];
  for (const [key, value] of Object.entries(headers)) {
    headerLines.push(`${key}: ${value}`);
  }

  if (normalized.attachments.length === 0) {
    return `${headerLines.join("\r\n")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${normalized.body_text}`;
  }

  const boundary = `rsp-${normalized.message_id}`;
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${normalized.body_text}\r\n`
  ];
  for (const attachment of normalized.attachments) {
    parts.push(
      `--${boundary}\r\nContent-Type: ${attachment.media_type}\r\nContent-Disposition: attachment; filename="${attachment.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${attachment.content_base64}\r\n`
    );
  }
  parts.push(`--${boundary}--`);
  return `${headerLines.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${parts.join("")}`;
}

function findHeader(headers = [], name) {
  const match = headers.find((header) => String(header.name || "").toLowerCase() === String(name).toLowerCase());
  return match?.value || null;
}

function walkParts(part, visitor) {
  if (!part) {
    return;
  }
  visitor(part);
  for (const child of part.parts || []) {
    walkParts(child, visitor);
  }
}

function extractPlainText(payload) {
  if (!payload) {
    return "";
  }
  let text = "";
  walkParts(payload, (part) => {
    if (text) {
      return;
    }
    if (part.mimeType === "text/plain" && part.body?.data) {
      text = base64UrlDecode(part.body.data).toString("utf8");
    }
  });
  if (!text && payload.body?.data) {
    text = base64UrlDecode(payload.body.data).toString("utf8");
  }
  return text;
}

async function extractAttachments(apiBaseUrl, user, accessToken, messageId, payload) {
  const attachments = [];
  const parts = [];
  walkParts(payload, (part) => {
    if (part.filename && (part.body?.attachmentId || part.body?.data)) {
      parts.push(part);
    }
  });
  for (const part of parts) {
    let content;
    if (part.body?.data) {
      content = base64UrlDecode(part.body.data);
    } else {
      const response = await request(
        `${apiBaseUrl}/users/${encodeURIComponent(user)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
        {
          headers: authHeaders(accessToken)
        }
      );
      if (response.status !== 200) {
        throw new Error(`gmail_attachment_fetch_failed:${response.status}`);
      }
      content = base64UrlDecode(response.body?.data || "");
    }
    attachments.push({
      attachment_id: part.body?.attachmentId || null,
      name: part.filename,
      media_type: part.mimeType || "application/octet-stream",
      content_base64: content.toString("base64"),
      byte_size: content.length
    });
  }
  return attachments;
}

async function loadMessage(apiBaseUrl, user, accessToken, message) {
  const response = await request(`${apiBaseUrl}/users/${encodeURIComponent(user)}/messages/${encodeURIComponent(message.id)}?format=full`, {
    headers: authHeaders(accessToken)
  });
  if (response.status !== 200) {
    throw new Error(`gmail_message_fetch_failed:${response.status}`);
  }
  const payload = response.body?.payload || {};
  const headers = payload.headers || [];
  const attachments = await extractAttachments(apiBaseUrl, user, accessToken, message.id, payload);
  const textBody = extractPlainText(payload);
  let parsedPayload = null;
  try {
    parsedPayload = textBody ? JSON.parse(textBody) : null;
  } catch {
    parsedPayload = null;
  }
  return normalizeEnvelope({
    message_id: response.body?.id || message.id,
    thread_id: response.body?.threadId || message.threadId || null,
    thread_hint: response.body?.threadId || message.threadId || null,
    request_id: findHeader(headers, "X-RSP-Request-Id") || parsedPayload?.request_id,
    from: findHeader(headers, "From"),
    to: findHeader(headers, "To"),
    subject: findHeader(headers, "Subject"),
    type: findHeader(headers, "X-RSP-Type") || parsedPayload?.type || "email.message",
    body_text: textBody,
    payload: parsedPayload,
    attachments
  });
}

export function createGmailTransportAdapter({
  clientId,
  clientSecret,
  refreshToken,
  user,
  receiver = user,
  sender = user,
  apiBaseUrl = "https://gmail.googleapis.com/gmail/v1",
  tokenUrl = "https://oauth2.googleapis.com/token"
}) {
  if (!clientId) {
    throw new Error("gmail_client_id_required");
  }
  if (!clientSecret) {
    throw new Error("gmail_client_secret_required");
  }
  if (!refreshToken) {
    throw new Error("gmail_refresh_token_required");
  }
  if (!user) {
    throw new Error("gmail_user_required");
  }

  return {
    async send(envelope) {
      const normalized = normalizeEnvelope({
        ...envelope,
        from: envelope.from || sender,
        to: envelope.to || receiver
      });
      const accessToken = await refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken });
      const raw = base64UrlEncode(Buffer.from(buildMimeMessage(normalized), "utf8"));
      const response = await request(`${apiBaseUrl}/users/${encodeURIComponent(user)}/messages/send`, {
        method: "POST",
        headers: authHeaders(accessToken, {
          "content-type": "application/json; charset=utf-8"
        }),
        body: JSON.stringify({ raw })
      });
      if (response.status !== 200) {
        throw new Error(`gmail_send_failed:${response.status}`);
      }
      return normalized;
    },

    async poll({ limit = 10 } = {}) {
      const accessToken = await refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken });
      const query = new URLSearchParams({
        q: `in:inbox is:unread subject:"${RSP_EMAIL_SUBJECT_PREFIX}"`,
        maxResults: String(limit)
      });
      const response = await request(`${apiBaseUrl}/users/${encodeURIComponent(user)}/messages?${query.toString()}`, {
        headers: authHeaders(accessToken)
      });
      if (response.status !== 200) {
        throw new Error(`gmail_poll_failed:${response.status}`);
      }
      const items = [];
      for (const message of response.body?.messages || []) {
        const loaded = await loadMessage(apiBaseUrl, user, accessToken, message);
        if (!isRspEmailSubject(loaded.subject || "")) {
          continue;
        }
        items.push(loaded);
      }
      return { items };
    },

    async ack(messageId) {
      const accessToken = await refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken });
      const response = await request(`${apiBaseUrl}/users/${encodeURIComponent(user)}/messages/${encodeURIComponent(messageId)}/modify`, {
        method: "POST",
        headers: authHeaders(accessToken, {
          "content-type": "application/json; charset=utf-8"
        }),
        body: JSON.stringify({
          removeLabelIds: ["UNREAD"]
        })
      });
      if (response.status !== 200) {
        throw new Error(`gmail_ack_failed:${response.status}`);
      }
      return { acked: true };
    },

    async health() {
      const accessToken = await refreshAccessToken({ tokenUrl, clientId, clientSecret, refreshToken });
      const response = await request(`${apiBaseUrl}/users/${encodeURIComponent(user)}/profile`, {
        headers: authHeaders(accessToken)
      });
      if (response.status !== 200) {
        throw new Error(`gmail_health_failed:${response.status}`);
      }
      return {
        ok: true,
        provider: "gmail",
        version: "gmail/v1",
        user
      };
    }
  };
}
