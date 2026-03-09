import "./styles.css";
import {
  renderAdminRequestCardsMarkup,
  renderAuditCardsMarkup,
  renderDetailSummary,
  renderEntityCardsMarkup,
  renderHistorySummary,
  renderPaginationSummary,
  renderReviewActionSummary,
  renderReviewerGuidance,
  renderReviewCardsMarkup
} from "./view-model.js";

const storageKeys = {
  platformUrl: "rsp.platform.url",
  platformApiKey: "rsp.platform.apiKey",
  actionReason: "rsp.platform.actionReason"
};

async function requestJson(baseUrl, pathname, { method = "GET", headers = {}, body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">Control Plane</p>
        <h1>Platform Console</h1>
        <p class="lede">Health, catalog, requests, and operator actions for the platform. Use the platform admin key here, or a user that was explicitly granted the admin role.</p>
      </div>
      <div class="status-block">
        <span class="pill">Health</span>
        <span class="pill cool">Metrics</span>
        <span class="pill warm">Admin</span>
      </div>
    </section>

    <section class="card endpoint">
      <h2>Platform Endpoint</h2>
      <div class="grid three">
        <div>
          <label>Platform API URL</label>
          <input id="platform-url" value="http://127.0.0.1:8080" />
        </div>
        <div>
          <label>Operator API Key</label>
          <input id="platform-api-key" placeholder="sk_admin_..." />
        </div>
        <div class="actions inline">
          <button id="refresh-overview">Refresh Overview</button>
        </div>
      </div>
      <label>Approval / Audit Reason</label>
      <input id="action-reason" value="operator review" />
      <label>Reviewer Notes</label>
      <textarea id="reviewer-notes" rows="4" placeholder="What was reviewed, what is being approved/rejected, and any follow-up."></textarea>
      <label>Global Filter</label>
      <input id="global-filter" placeholder="seller, subagent, request, action..." />
      <label>Section Filter</label>
      <select id="section-filter">
        <option value="all">all</option>
        <option value="sellers">sellers</option>
        <option value="subagents">subagents</option>
        <option value="requests">requests</option>
        <option value="audit">audit</option>
        <option value="reviews">reviews</option>
      </select>
    </section>

    <section class="grid three-panels">
      <div class="card">
        <h2>Overview</h2>
        <pre id="overview-output" class="output">Waiting for platform endpoint.</pre>
      </div>
      <div class="card">
        <div class="section-head">
          <h2>Sellers</h2>
          <div class="actions inline">
            <button id="sellers-prev" class="ghost">Prev</button>
            <button id="sellers-next" class="ghost">Next</button>
            <button id="refresh-sellers" class="ghost">Reload</button>
          </div>
        </div>
        <p id="sellers-page" class="meta">sellers: no data</p>
        <div id="sellers-list" class="stack"></div>
      </div>
      <div class="card">
        <div class="section-head">
          <h2>Subagents</h2>
          <div class="actions inline">
            <button id="subagents-prev" class="ghost">Prev</button>
            <button id="subagents-next" class="ghost">Next</button>
            <button id="refresh-subagents" class="ghost">Reload</button>
          </div>
        </div>
        <p id="subagents-page" class="meta">subagents: no data</p>
        <div id="subagents-list" class="stack"></div>
      </div>
    </section>

    <section class="grid two">
      <div class="card">
        <div class="section-head">
          <h2>Requests</h2>
          <div class="actions inline">
            <button id="requests-prev" class="ghost">Prev</button>
            <button id="requests-next" class="ghost">Next</button>
            <button id="refresh-requests" class="ghost">Reload</button>
          </div>
        </div>
        <p id="requests-page" class="meta">requests: no data</p>
        <div id="requests-list" class="stack"></div>
        <pre id="requests-output" class="output compact">No request data loaded yet.</pre>
      </div>
      <div class="card">
        <div class="section-head">
          <h2>Catalog</h2>
          <button id="refresh-catalog" class="ghost">Reload</button>
        </div>
        <pre id="catalog-output" class="output compact">No catalog data loaded yet.</pre>
      </div>
    </section>

    <section class="grid two">
      <div class="card">
        <div class="section-head">
          <h2>Audit Trail</h2>
          <div class="actions inline">
            <button id="audit-prev" class="ghost">Prev</button>
            <button id="audit-next" class="ghost">Next</button>
            <button id="refresh-audit" class="ghost">Reload</button>
          </div>
        </div>
        <p id="audit-page" class="meta">audit: no data</p>
        <div id="audit-list" class="stack"></div>
        <pre id="audit-output" class="output compact">No audit data loaded yet.</pre>
      </div>
      <div class="card">
        <div class="section-head">
          <h2>Review Queue</h2>
          <div class="actions inline">
            <button id="reviews-prev" class="ghost">Prev</button>
            <button id="reviews-next" class="ghost">Next</button>
            <button id="refresh-reviews" class="ghost">Reload</button>
          </div>
        </div>
        <p id="reviews-page" class="meta">reviews: no data</p>
        <div id="reviews-list" class="stack"></div>
        <pre id="reviews-output" class="output compact">No review data loaded yet.</pre>
      </div>
    </section>

    <section class="grid one">
      <div class="card">
        <div class="section-head">
          <h2>Selection Detail</h2>
        </div>
        <div id="reviewer-guidance" class="stack"></div>
        <div id="review-action-summary" class="stack"></div>
        <div id="detail-summary" class="stack"></div>
        <div id="detail-history" class="stack"></div>
        <pre id="detail-output" class="output compact">No item selected yet.</pre>
      </div>
    </section>
  </main>
`;

const platformUrlInput = document.querySelector("#platform-url");
const platformKeyInput = document.querySelector("#platform-api-key");
const actionReasonInput = document.querySelector("#action-reason");
const reviewerNotesInput = document.querySelector("#reviewer-notes");
const globalFilterInput = document.querySelector("#global-filter");
const sectionFilterInput = document.querySelector("#section-filter");
const overviewOutput = document.querySelector("#overview-output");
const requestsOutput = document.querySelector("#requests-output");
const requestsList = document.querySelector("#requests-list");
const catalogOutput = document.querySelector("#catalog-output");
const auditOutput = document.querySelector("#audit-output");
const auditList = document.querySelector("#audit-list");
const reviewsOutput = document.querySelector("#reviews-output");
const reviewsList = document.querySelector("#reviews-list");
const reviewerGuidance = document.querySelector("#reviewer-guidance");
const reviewActionSummary = document.querySelector("#review-action-summary");
const detailSummary = document.querySelector("#detail-summary");
const detailHistory = document.querySelector("#detail-history");
const detailOutput = document.querySelector("#detail-output");
const sellersList = document.querySelector("#sellers-list");
const subagentsList = document.querySelector("#subagents-list");
const pageOutputs = {
  sellers: document.querySelector("#sellers-page"),
  subagents: document.querySelector("#subagents-page"),
  requests: document.querySelector("#requests-page"),
  audit: document.querySelector("#audit-page"),
  reviews: document.querySelector("#reviews-page")
};
const uiState = {
  sellers: [],
  subagents: [],
  requests: [],
  audit: [],
  reviews: [],
  detail: null,
  pagination: {
    sellers: { limit: 8, offset: 0, total: 0, has_more: false },
    subagents: { limit: 8, offset: 0, total: 0, has_more: false },
    requests: { limit: 8, offset: 0, total: 0, has_more: false },
    audit: { limit: 8, offset: 0, total: 0, has_more: false },
    reviews: { limit: 8, offset: 0, total: 0, has_more: false }
  }
};

function authHeaders() {
  const apiKey = platformKeyInput.value.trim();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function savePrefs() {
  localStorage.setItem(storageKeys.platformUrl, platformUrlInput.value);
  localStorage.setItem(storageKeys.platformApiKey, platformKeyInput.value);
  localStorage.setItem(storageKeys.actionReason, actionReasonInput.value);
  localStorage.setItem("rsp.platform.reviewerNotes", reviewerNotesInput.value);
}

function loadPrefs() {
  platformUrlInput.value = localStorage.getItem(storageKeys.platformUrl) || platformUrlInput.value;
  platformKeyInput.value = localStorage.getItem(storageKeys.platformApiKey) || platformKeyInput.value;
  actionReasonInput.value = localStorage.getItem(storageKeys.actionReason) || actionReasonInput.value;
  reviewerNotesInput.value = localStorage.getItem("rsp.platform.reviewerNotes") || "";
}

function applyFilter(items) {
  const term = globalFilterInput.value.trim().toLowerCase();
  if (!term) {
    return items;
  }
  return items.filter((item) => JSON.stringify(item).toLowerCase().includes(term));
}

function setDetail(item) {
  uiState.detail = item;
  reviewerGuidance.innerHTML = renderReviewerGuidance(item);
  detailSummary.innerHTML = renderDetailSummary(item);
  const sellerId = item?.seller_id || (item?.target_type === "seller" ? item.target_id : null);
  const subagentId =
    item?.subagent_id ||
    (item?.target_type === "subagent" ? item.target_id : null) ||
    (item?.seller_id ? null : item?.subagent_id || null);
  const matchingReviews = uiState.reviews.filter(
    (entry) =>
      (sellerId && entry.target_type === "seller" && entry.target_id === sellerId) ||
      (subagentId && entry.target_type === "subagent" && entry.target_id === subagentId)
  );
  const matchingAudit = uiState.audit.filter(
    (entry) =>
      (sellerId && entry.target_type === "seller" && entry.target_id === sellerId) ||
      (subagentId && entry.target_type === "subagent" && entry.target_id === subagentId)
  );
  const combinedHistory = [...matchingReviews, ...matchingAudit].sort((left, right) =>
    String(right.recorded_at || "").localeCompare(String(left.recorded_at || ""))
  );
  detailHistory.innerHTML = `
    ${renderHistorySummary(matchingReviews, "Review History")}
    ${renderHistorySummary(matchingAudit, "Audit History")}
  `;
  reviewActionSummary.innerHTML = renderReviewActionSummary(item, reviewerNotesInput.value.trim(), combinedHistory);
  detailOutput.textContent = item ? JSON.stringify(item, null, 2) : "No item selected yet.";
}

function updatePageSummary(section) {
  pageOutputs[section].textContent = renderPaginationSummary(uiState.pagination[section], section);
}

function queryWithPagination(section) {
  const query = new URLSearchParams({
    limit: String(uiState.pagination[section].limit),
    offset: String(uiState.pagination[section].offset)
  });
  const q = globalFilterInput.value.trim();
  if (q) {
    query.set("q", q);
  }
  return query;
}

function sectionVisible(section) {
  return sectionFilterInput.value === "all" || sectionFilterInput.value === section;
}

function renderRequestCards(items) {
  requestsList.innerHTML = renderAdminRequestCardsMarkup(items);
}

function renderAuditCards(items) {
  auditList.innerHTML = renderAuditCardsMarkup(items);
}

function renderReviewCards(items) {
  reviewsList.innerHTML = renderReviewCardsMarkup(items);
}

async function refreshOverview() {
  overviewOutput.textContent = "Loading overview...";
  try {
    const [health, metrics] = await Promise.all([
      requestJson(platformUrlInput.value, "/healthz"),
      requestJson(platformUrlInput.value, "/v1/metrics/summary", { headers: authHeaders() })
    ]);
    overviewOutput.textContent = JSON.stringify({ health, metrics }, null, 2);
  } catch (error) {
    overviewOutput.textContent = `Platform status failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function refreshCatalog() {
  catalogOutput.textContent = "Loading catalog...";
  try {
    const catalog = await requestJson(platformUrlInput.value, "/v1/catalog/subagents");
    catalogOutput.textContent = JSON.stringify({ ...catalog, body: { items: applyFilter(catalog.body?.items || []) } }, null, 2);
  } catch (error) {
    catalogOutput.textContent = `Catalog load failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function refreshRequests() {
  if (!sectionVisible("requests")) {
    requestsList.innerHTML = `<div class="empty">Requests hidden by section filter.</div>`;
    return;
  }
  requestsOutput.textContent = "Loading requests...";
  try {
    const requests = await requestJson(platformUrlInput.value, `/v1/admin/requests?${queryWithPagination("requests").toString()}`, {
      headers: authHeaders()
    });
    uiState.requests = requests.body?.items || [];
    uiState.pagination.requests = requests.body?.pagination || uiState.pagination.requests;
    const filteredItems = applyFilter(uiState.requests);
    renderRequestCards(filteredItems);
    updatePageSummary("requests");
    requestsOutput.textContent = JSON.stringify({ ...requests, body: { items: filteredItems } }, null, 2);
  } catch (error) {
    requestsOutput.textContent = `Request load failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function refreshSellers() {
  if (!sectionVisible("sellers")) {
    sellersList.innerHTML = `<div class="empty">Sellers hidden by section filter.</div>`;
    return;
  }
  sellersList.innerHTML = `<div class="empty">Loading sellers...</div>`;
  try {
    const sellers = await requestJson(platformUrlInput.value, `/v1/admin/sellers?${queryWithPagination("sellers").toString()}`, {
      headers: authHeaders()
    });
    uiState.sellers = sellers.body?.items || [];
    uiState.pagination.sellers = sellers.body?.pagination || uiState.pagination.sellers;
    sellersList.innerHTML = renderEntityCardsMarkup(applyFilter(uiState.sellers), "sellers");
    updatePageSummary("sellers");
  } catch (error) {
    sellersList.innerHTML = `<div class="empty">Seller load failed: ${error instanceof Error ? error.message : "unknown_error"}</div>`;
  }
}

async function refreshSubagents() {
  if (!sectionVisible("subagents")) {
    subagentsList.innerHTML = `<div class="empty">Subagents hidden by section filter.</div>`;
    return;
  }
  subagentsList.innerHTML = `<div class="empty">Loading subagents...</div>`;
  try {
    const subagents = await requestJson(
      platformUrlInput.value,
      `/v1/admin/subagents?${queryWithPagination("subagents").toString()}`,
      {
      headers: authHeaders()
      }
    );
    uiState.subagents = subagents.body?.items || [];
    uiState.pagination.subagents = subagents.body?.pagination || uiState.pagination.subagents;
    subagentsList.innerHTML = renderEntityCardsMarkup(applyFilter(uiState.subagents), "subagents");
    updatePageSummary("subagents");
  } catch (error) {
    subagentsList.innerHTML = `<div class="empty">Subagent load failed: ${error instanceof Error ? error.message : "unknown_error"}</div>`;
  }
}

async function refreshAudit() {
  if (!sectionVisible("audit")) {
    auditList.innerHTML = `<div class="empty">Audit hidden by section filter.</div>`;
    return;
  }
  auditOutput.textContent = "Loading audit trail...";
  try {
    const query = queryWithPagination("audit");
    const audit = await requestJson(platformUrlInput.value, `/v1/admin/audit-events?${query.toString()}`, {
      headers: authHeaders()
    });
    uiState.audit = audit.body?.items || [];
    uiState.pagination.audit = audit.body?.pagination || uiState.pagination.audit;
    const filteredItems = applyFilter(uiState.audit);
    renderAuditCards(filteredItems);
    updatePageSummary("audit");
    auditOutput.textContent = JSON.stringify({ ...audit, body: { items: filteredItems } }, null, 2);
  } catch (error) {
    auditOutput.textContent = `Audit load failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function refreshReviews() {
  if (!sectionVisible("reviews")) {
    reviewsList.innerHTML = `<div class="empty">Reviews hidden by section filter.</div>`;
    return;
  }
  reviewsOutput.textContent = "Loading review queue...";
  try {
    const query = queryWithPagination("reviews");
    const reviews = await requestJson(platformUrlInput.value, `/v1/admin/reviews?${query.toString()}`, {
      headers: authHeaders()
    });
    uiState.reviews = reviews.body?.items || [];
    uiState.pagination.reviews = reviews.body?.pagination || uiState.pagination.reviews;
    const filteredItems = applyFilter(uiState.reviews);
    renderReviewCards(filteredItems);
    updatePageSummary("reviews");
    reviewsOutput.textContent = JSON.stringify({ ...reviews, body: { items: filteredItems } }, null, 2);
  } catch (error) {
    reviewsOutput.textContent = `Review load failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function runAction(type, id, action) {
  const pathname =
    type === "sellers" ? `/v1/admin/sellers/${id}/${action}` : `/v1/admin/subagents/${id}/${action}`;
  await requestJson(platformUrlInput.value, pathname, {
    method: "POST",
    headers: authHeaders(),
    body: {
      reason: reviewerNotesInput.value.trim() || document.querySelector("#action-reason").value.trim() || null
    }
  });
  await Promise.all([refreshSellers(), refreshSubagents(), refreshCatalog(), refreshAudit(), refreshReviews()]);
}

sellersList.addEventListener("click", async (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card && !event.target.closest("button")) {
    setDetail(uiState.sellers.find((item) => item.seller_id === card.dataset.detailId) || null);
  }
  const button = event.target.closest("button[data-type='sellers']");
  if (!button) {
    return;
  }
  await runAction("sellers", button.dataset.id, button.dataset.action);
});

subagentsList.addEventListener("click", async (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (card && !event.target.closest("button")) {
    setDetail(uiState.subagents.find((item) => item.subagent_id === card.dataset.detailId) || null);
  }
  const button = event.target.closest("button[data-type='subagents']");
  if (!button) {
    return;
  }
  await runAction("subagents", button.dataset.id, button.dataset.action);
});

requestsList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (!card) {
    return;
  }
  setDetail(uiState.requests.find((item) => item.request_id === card.dataset.detailId) || null);
});

auditList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (!card) {
    return;
  }
  setDetail(uiState.audit.find((item) => item.id === card.dataset.detailId) || null);
});

reviewsList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-detail-id]");
  if (!card) {
    return;
  }
  setDetail(uiState.reviews.find((item) => item.id === card.dataset.detailId) || null);
});

for (const section of ["sellers", "subagents", "requests", "audit", "reviews"]) {
  document.querySelector(`#${section}-prev`).addEventListener("click", async () => {
    const pagination = uiState.pagination[section];
    pagination.offset = Math.max(0, pagination.offset - pagination.limit);
    await ({ sellers: refreshSellers, subagents: refreshSubagents, requests: refreshRequests, audit: refreshAudit, reviews: refreshReviews }[section])();
  });

  document.querySelector(`#${section}-next`).addEventListener("click", async () => {
    const pagination = uiState.pagination[section];
    if (!pagination.has_more) {
      return;
    }
    pagination.offset += pagination.limit;
    await ({ sellers: refreshSellers, subagents: refreshSubagents, requests: refreshRequests, audit: refreshAudit, reviews: refreshReviews }[section])();
  });
}

document.querySelector("#refresh-overview").addEventListener("click", async () => {
  await Promise.all([refreshOverview(), refreshSellers(), refreshSubagents(), refreshRequests(), refreshCatalog(), refreshAudit(), refreshReviews()]);
});
document.querySelector("#refresh-sellers").addEventListener("click", refreshSellers);
document.querySelector("#refresh-subagents").addEventListener("click", refreshSubagents);
document.querySelector("#refresh-requests").addEventListener("click", refreshRequests);
document.querySelector("#refresh-catalog").addEventListener("click", refreshCatalog);
document.querySelector("#refresh-audit").addEventListener("click", refreshAudit);
document.querySelector("#refresh-reviews").addEventListener("click", refreshReviews);
globalFilterInput.addEventListener("input", () => {
  for (const pagination of Object.values(uiState.pagination)) {
    pagination.offset = 0;
  }
  void Promise.all([refreshSellers(), refreshSubagents(), refreshRequests(), refreshCatalog(), refreshAudit(), refreshReviews()]);
});
sectionFilterInput.addEventListener("change", () => {
  void Promise.all([refreshSellers(), refreshSubagents(), refreshRequests(), refreshAudit(), refreshReviews()]);
});
for (const input of [platformUrlInput, platformKeyInput, actionReasonInput, reviewerNotesInput]) {
  input.addEventListener("change", savePrefs);
  input.addEventListener("blur", savePrefs);
}
reviewerNotesInput.addEventListener("input", () => {
  if (uiState.detail) {
    setDetail(uiState.detail);
  }
});

loadPrefs();
Promise.all([refreshOverview(), refreshSellers(), refreshSubagents(), refreshRequests(), refreshCatalog(), refreshAudit(), refreshReviews()]).catch(() => {});
