export function renderBuyerSummaryCard({ health, root }) {
  const usingLocalCredential = root?.body?.local_defaults?.platform_api_key_configured;
  const contactEmail = root?.body?.local_defaults?.buyer_contact_email;
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>${root?.body?.service || "buyer-controller"}</strong>
          <p>${root?.body?.platform?.configured ? "Platform connected" : "Platform not configured"}</p>
        </div>
        <span class="status ${health?.body?.ok ? "healthy" : "disabled"}">${health?.body?.ok ? "healthy" : "down"}</span>
      </div>
      <p class="meta">Mode: buyer runtime${usingLocalCredential ? " · local env credential loaded" : ""}</p>
      ${contactEmail ? `<p class="meta">Buyer: ${contactEmail}</p>` : ""}
    </article>
  `;
}

export function renderRequestSummaryMarkup(summary) {
  if (!summary) {
    return `<div class="empty">No request summary available yet.</div>`;
  }
  const statuses = Object.entries(summary.by_status || {})
    .map(([status, count]) => `${status}: ${count}`)
    .join(" · ");
  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>Recent Requests</strong>
          <p>${summary.total || 0} total</p>
        </div>
        <span class="status ${summary.total > 0 ? "healthy" : "disabled"}">${summary.total > 0 ? "active" : "idle"}</span>
      </div>
      <p class="meta">${statuses || "No recent requests"}</p>
    </article>
  `;
}

export function renderSetupWizardMarkup(status) {
  const config = status?.config || {};
  const seller = config.seller || {};
  const buyer = config.buyer || {};
  const buyerRegistered = buyer.api_key_configured === true;
  const subagents = seller.subagents || [];
  const exampleConfigured = subagents.some((item) => item.subagent_id === "local.summary.v1");
  const submittedCount = subagents.filter((item) => item.submitted_for_review === true).length;
  const pendingReviewCount = subagents.filter((item) => item.submitted_for_review !== true).length;
  const steps = [
    {
      title: "Setup Local Client",
      done: Boolean(status?.runtime?.supervisor?.port),
      detail: "Initialize ~/.delexec and local supervisor defaults.",
      action: "setup",
      actionLabel: "Run Setup"
    },
    {
      title: "Register Buyer",
      done: buyerRegistered,
      detail: buyer.contact_email ? `Buyer: ${buyer.contact_email}` : "Create a buyer API key for local use.",
      action: "register-buyer",
      actionLabel: "Register Buyer"
    },
    {
      title: "Add Local Example",
      done: exampleConfigured,
      detail: exampleConfigured
        ? "Official local.summary.v1 demo subagent is configured."
        : "Install the official example subagent to learn the local seller shape.",
      action: "add-example-subagent",
      actionLabel: "Add Example"
    },
    {
      title: "Submit Review",
      done: submittedCount > 0,
      detail: submittedCount > 0
        ? "At least one local subagent has been submitted for review."
        : "Submit local subagents to the platform review queue.",
      action: "submit-review",
      actionLabel: "Submit Review",
      blockedReason: !buyerRegistered
        ? "Register buyer before submitting review."
        : subagents.length === 0
          ? "Add at least one local subagent before review."
          : pendingReviewCount === 0
            ? "No pending local subagents to submit."
            : null
    },
    {
      title: "Enable Seller",
      done: seller.enabled === true,
      detail: seller.enabled === true ? "Seller runtime enabled locally." : "Enable the local seller runtime after review submission.",
      action: "enable-seller",
      actionLabel: "Enable Seller",
      blockedReason: !buyerRegistered
        ? "Register buyer before enabling seller."
        : subagents.length === 0
          ? "Add a local subagent before enabling seller."
          : null
    }
  ];

  const cards = steps
    .map(
      (step) => `
        <article class="item-card">
          <div class="item-head">
            <div>
              <strong>${step.title}</strong>
              <p>${step.detail}</p>
              ${step.blockedReason && !step.done ? `<p class="meta">Blocked: ${step.blockedReason}</p>` : ""}
            </div>
            <span class="status ${step.done ? "healthy" : "disabled"}">${step.done ? "done" : "pending"}</span>
          </div>
          <div class="actions">
            <button data-wizard-action="${step.action}" class="${step.done ? "ghost" : ""}" ${
              step.blockedReason && !step.done ? "disabled" : ""
            }>${step.done ? "Review" : step.actionLabel}</button>
          </div>
        </article>
      `
    )
    .join("");

  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>Onboarding Summary</strong>
          <p>buyer ${buyerRegistered ? "registered" : "pending"} · seller ${seller.enabled ? "enabled" : "disabled"}</p>
        </div>
        <span class="status ${buyerRegistered ? "healthy" : "disabled"}">${subagents.length} subagents</span>
      </div>
      <p class="meta">Submitted: ${submittedCount} · Pending review: ${pendingReviewCount}</p>
    </article>
    ${cards}
  `;
}

export function renderCatalogItemsMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No catalog items match the current filter.</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="item-card" data-subagent-detail-id="${item.subagent_id}">
          <div class="item-head">
            <div>
              <strong>${item.display_name || item.subagent_id}</strong>
              <p>${item.subagent_id}</p>
            </div>
            <span class="status ${item.availability_status || "healthy"}">${item.availability_status || "healthy"}</span>
          </div>
          <p class="meta">${item.seller_id} · ${(item.capabilities || []).join(", ") || "no capabilities"}</p>
          <p class="meta">${
            item.subagent_id === "local.summary.v1" || (item.tags || []).includes("demo")
              ? "local demo seller"
              : "catalog / remote seller"
          }</p>
        </article>
      `
    )
    .join("");
}

export function renderRequestsMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No requests match the current filter.</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="item-card" data-request-id="${item.request_id}">
          <div class="item-head">
            <div>
              <strong>${item.request_id}</strong>
              <p>${item.seller_id || "unbound seller"} · ${item.subagent_id || "unbound subagent"}</p>
            </div>
            <span class="status ${String(item.status || "").toLowerCase()}">${item.status}</span>
          </div>
          <p class="meta">Updated: ${item.updated_at || item.created_at || "n/a"}</p>
        </article>
      `
    )
    .join("");
}

export function renderRequestDetailMarkup({ request, result }) {
  if (!request) {
    return `<div class="empty">No request selected yet.</div>`;
  }

  const resultStatus = result?.available
    ? result.result_package?.status || "available"
    : result?.available === false
      ? "pending"
      : "unknown";
  const summary =
    result?.result_package?.output?.summary ||
    result?.result_package?.error?.message ||
    request.result_package?.output?.summary ||
    request.last_error_code ||
    "No result payload yet.";
  const timeline = Array.isArray(request.timeline)
    ? request.timeline.map((entry) => `<li>${entry.at || "n/a"} · ${entry.event || "UNKNOWN"}</li>`).join("")
    : "";
  const platformEvents = Array.isArray(request.platform_events)
    ? request.platform_events.map((entry) => `<li>${entry.at || "n/a"} · ${entry.event_type || "UNKNOWN"}</li>`).join("")
    : "";
  const resultPayload = result?.result_package || request.result_package || null;
  const topSummary =
    result?.available === false
      ? "Waiting for seller result."
      : resultPayload?.error?.message || resultPayload?.output?.summary || "No result payload yet.";

  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>${request.request_id}</strong>
          <p>${request.seller_id || "unbound seller"} · ${request.subagent_id || "unbound subagent"}</p>
        </div>
        <span class="status ${String(request.status || "unknown").toLowerCase()}">${request.status || "UNKNOWN"}</span>
      </div>
      <p class="meta">Result: ${resultStatus} · Updated: ${request.updated_at || request.created_at || "n/a"}</p>
      <div class="item-card">
        <strong>Result Summary</strong>
        <p class="meta">status=${resultStatus}</p>
        <p class="meta">${topSummary}</p>
      </div>
      <div class="stack">
        <div class="item-card">
          <strong>Result Payload</strong>
          <pre class="output compact">${JSON.stringify(resultPayload, null, 2) || "null"}</pre>
        </div>
        <div class="item-card">
          <strong>Timeline</strong>
          ${timeline ? `<ul class="meta-list">${timeline}</ul>` : `<div class="empty">No timeline yet.</div>`}
        </div>
        <div class="item-card">
          <strong>Platform Events</strong>
          ${platformEvents ? `<ul class="meta-list">${platformEvents}</ul>` : `<div class="empty">No platform events yet.</div>`}
        </div>
      </div>
    </article>
  `;
}

export function renderTransportConfigMarkup(transport, lastTest = null) {
  if (!transport) {
    return `<div class="empty">Transport config not loaded yet.</div>`;
  }

  const details = [];
  details.push(`type=${transport.type}`);
  if (transport.type === "relay_http") {
    details.push(`base_url=${transport.relay_http?.base_url || "unset"}`);
  }
  if (transport.type === "email") {
    details.push(`provider=${transport.email?.provider || "unset"}`);
    details.push(`sender=${transport.email?.sender || "unset"}`);
    details.push(`receiver=${transport.email?.receiver || "unset"}`);
    details.push(`poll=${transport.email?.poll_interval_ms || "unset"}ms`);
    if (transport.email?.provider === "emailengine") {
      details.push(`account=${transport.email?.emailengine?.account || "unset"}`);
      details.push(`token=${transport.email?.emailengine?.access_token_configured ? "configured" : "missing"}`);
    }
    if (transport.email?.provider === "gmail") {
      details.push(`user=${transport.email?.gmail?.user || "unset"}`);
      details.push(`client_secret=${transport.email?.gmail?.client_secret_configured ? "configured" : "missing"}`);
      details.push(`refresh_token=${transport.email?.gmail?.refresh_token_configured ? "configured" : "missing"}`);
    }
  }

  const lastTestMarkup = lastTest
    ? `<div class="item-card">
        <strong>Last Test</strong>
        <pre class="output compact">${JSON.stringify(lastTest, null, 2)}</pre>
      </div>`
    : `<div class="empty">No connection test run yet.</div>`;

  return `
    <article class="item-card">
      <div class="item-head">
        <div>
          <strong>Runtime Transport</strong>
          <p>${details.join(" · ")}</p>
        </div>
        <span class="status ${transport.type === "email" ? "pending" : "healthy"}">${transport.type}</span>
      </div>
    </article>
    ${lastTestMarkup}
  `;
}

export function renderSellerSubagentsMarkup(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<div class="empty">No local subagents configured yet.</div>`;
  }
  return items
    .map(
      (item) => `
        <article class="item-card">
          <div class="item-head">
            <div>
              <strong>${item.display_name || item.subagent_id}</strong>
              <p>${item.subagent_id}</p>
            </div>
            <span class="status ${item.enabled === false ? "disabled" : "healthy"}">${item.enabled === false ? "disabled" : "enabled"}</span>
          </div>
          <p class="meta">${item.adapter_type || "process"} · ${(item.capabilities || []).join(", ") || "no capabilities"}</p>
          <p class="meta">Review: ${item.review_status || "local_only"} · ${item.submitted_for_review ? "submitted" : "local only"}</p>
          <p class="meta">${item.subagent_id === "local.summary.v1" ? "official local demo seller" : "custom local seller"}</p>
          <div class="actions">
            <button data-subagent-action="edit" data-subagent-id="${item.subagent_id}">Edit</button>
            ${
              item.enabled === false
                ? `<button data-subagent-action="enable" data-subagent-id="${item.subagent_id}">Enable</button>`
                : `<button data-subagent-action="disable" data-subagent-id="${item.subagent_id}" class="ghost">Disable</button>`
            }
            <button data-subagent-action="remove" data-subagent-id="${item.subagent_id}" class="ghost">Remove</button>
          </div>
        </article>
      `
    )
    .join("");
}

export function renderRuntimeCardsMarkup(runtime) {
  if (!runtime) {
    return `<div class="empty">No runtime status available yet.</div>`;
  }

  const services = ["relay", "buyer", "seller"];
  return services
    .map((name) => {
      const item = runtime[name] || {};
      const healthy = item.health?.body?.ok === true;
      const running = item.running === true;
      const badge = healthy ? "healthy" : running ? "acked" : "disabled";
      return `
        <article class="item-card">
          <div class="item-head">
            <div>
              <strong>${name}</strong>
              <p>pid: ${item.pid || "n/a"}</p>
            </div>
            <span class="status ${badge}">${healthy ? "healthy" : running ? "running" : "stopped"}</span>
          </div>
          <p class="meta">Started: ${item.started_at || "n/a"}</p>
          <p class="meta">Exit: ${item.exit_code ?? "n/a"}${item.last_error ? ` · ${item.last_error}` : ""}</p>
        </article>
      `;
    })
    .join("");
}

export function renderRuntimeAlertsMarkup(service, alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return `<div class="empty">No recent errors or warnings for ${service}.</div>`;
  }
  return alerts
    .map(
      (item) => `
        <article class="item-card">
          <div class="item-head">
            <div>
              <strong>${item.service || service}</strong>
              <p>${item.source || "runtime"}${item.at ? ` · ${item.at}` : ""}</p>
            </div>
            <span class="status ${item.severity === "error" ? "disabled" : "warm"}">${item.severity || "info"}</span>
          </div>
          <p class="meta">${item.message || "unknown_alert"}</p>
        </article>
      `
    )
    .join("");
}
