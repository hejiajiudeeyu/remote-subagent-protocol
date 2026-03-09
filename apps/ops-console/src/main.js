import "./styles.css";
import {
  renderBuyerSummaryCard,
  renderCatalogItemsMarkup,
  renderRequestDetailMarkup,
  renderRequestSummaryMarkup,
  renderRequestsMarkup,
  renderRuntimeAlertsMarkup,
  renderRuntimeCardsMarkup,
  renderSetupWizardMarkup,
  renderSellerSubagentsMarkup
} from "./view-model.js";

async function requestJson(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

const DEFAULT_OPS_URL = "http://127.0.0.1:8079";
const storageKeys = {
  buyerEmail: "rsp.ops.buyerEmail"
};

const state = {
  latestRequestId: null,
  resultPollTimer: null,
  catalogItems: [],
  requests: [],
  latestRequest: null,
  latestResult: null,
  status: null,
  runtimeService: "buyer",
  editingSubagentId: null
};

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div>
        <p class="eyebrow">Unified Ops Client</p>
        <h1>Ops Console</h1>
        <p class="lede">Buyer, seller, and relay are managed through one local supervisor.</p>
      </div>
      <div class="hero-note">
        <span class="pill">Buyer always on</span>
        <span class="pill warm">Seller opt-in</span>
      </div>
    </section>

    <section class="panel grid two">
      <div class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Setup</p>
            <h2>Local Client</h2>
          </div>
          <button id="refresh-status" class="ghost">Refresh</button>
        </div>
        <p class="meta">Supervisor: ${DEFAULT_OPS_URL}</p>
        <label>Buyer Contact Email</label>
        <input id="buyer-email" value="buyer@local.test" />
        <div class="actions">
          <button id="setup-client">Setup Client</button>
          <button id="register-buyer">Register Buyer</button>
        </div>
        <div id="setup-wizard" class="stack"></div>
        <div id="buyer-summary" class="stack"></div>
        <div id="request-summary" class="stack"></div>
        <pre id="status-output" class="output compact">Waiting for ops supervisor.</pre>
      </div>

      <div class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Runtime</p>
            <h2>Buyer / Seller / Relay</h2>
          </div>
          <div class="actions">
            <select id="runtime-service">
              <option value="buyer">buyer</option>
              <option value="seller">seller</option>
              <option value="relay">relay</option>
            </select>
            <button id="refresh-runtime" class="ghost">Logs</button>
            <button id="debug-snapshot" class="ghost">Debug Snapshot</button>
          </div>
        </div>
        <div id="runtime-cards" class="stack"></div>
        <div id="runtime-alerts" class="stack"></div>
        <pre id="debug-output" class="output compact">Debug snapshot not loaded yet.</pre>
        <pre id="runtime-output" class="output">Runtime logs not loaded yet.</pre>
      </div>
    </section>

    <section class="panel grid two">
      <div class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Seller</p>
            <h2>Subagents + Review</h2>
          </div>
        </div>
        <div class="grid three">
          <div>
            <label>Seller ID</label>
            <input id="seller-id" value="seller_local" />
          </div>
          <div>
            <label>Subagent ID</label>
            <input id="subagent-id" value="local.subagent.v1" />
          </div>
          <div>
            <label>Display Name</label>
            <input id="display-name" value="Local Seller Runtime" />
          </div>
        </div>
        <div class="grid three">
          <div>
            <label>Task Types</label>
            <input id="task-types" value="text_classify" />
          </div>
          <div>
            <label>Capabilities</label>
            <input id="capabilities" value="text.classify" />
          </div>
          <div>
            <label>Tags</label>
            <input id="tags" value="local,ops" />
          </div>
        </div>
        <label>Adapter Type</label>
        <select id="adapter-type">
          <option value="process">process</option>
          <option value="http">http</option>
        </select>
        <label>Command / URL</label>
        <input id="adapter-value" value="node worker.js" />
        <p id="subagent-form-mode" class="meta">Creating a new local subagent.</p>
        <div class="actions">
          <button id="add-subagent">Add Subagent</button>
          <button id="reset-subagent-form" class="ghost">Clear Form</button>
          <button id="submit-review" class="ghost">Submit For Review</button>
          <button id="enable-seller">Enable Seller</button>
        </div>
        <pre id="seller-output" class="output compact">Seller is not enabled yet.</pre>
        <div id="seller-subagents" class="stack"></div>
      </div>

      <div class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Catalog</p>
            <h2>Marketplace</h2>
          </div>
          <button id="refresh-catalog" class="ghost">Refresh Catalog</button>
        </div>
        <label>Catalog / Request Filter</label>
        <input id="buyer-filter" placeholder="seller, subagent, status..." />
        <div id="catalog-list" class="stack"></div>
      </div>
    </section>

    <section class="panel grid two">
      <div class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Requests</p>
            <h2>Dispatch Remote Request</h2>
          </div>
          <button id="refresh-requests" class="ghost">Requests</button>
        </div>
        <div class="grid three">
          <div>
            <label>Seller ID</label>
            <input id="request-seller-id" value="seller_foxlab" />
          </div>
          <div>
            <label>Subagent ID</label>
            <input id="request-subagent-id" value="foxlab.text.classifier.v1" />
          </div>
          <div>
            <label>Task Type</label>
            <input id="request-task-type" value="text_classify" />
          </div>
        </div>
        <label>Prompt / Input Text</label>
        <textarea id="request-text">Classify this text into a suitable category.</textarea>
        <div class="actions">
          <button id="load-first-catalog" class="ghost">Use First Catalog Item</button>
          <button id="dispatch-request">Dispatch Remote Request</button>
          <button id="poll-result" class="ghost">Fetch Result</button>
        </div>
        <div id="requests-list" class="stack"></div>
        <pre id="request-output" class="output compact">No request dispatched yet.</pre>
      </div>

      <div class="card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Request Detail</p>
            <h2>Latest Selected Request</h2>
          </div>
        </div>
        <div id="request-detail" class="stack"><div class="empty">No request selected yet.</div></div>
      </div>
    </section>
  </main>
`;

const buyerEmailInput = document.querySelector("#buyer-email");
const buyerFilterInput = document.querySelector("#buyer-filter");
const runtimeServiceInput = document.querySelector("#runtime-service");
const statusOutput = document.querySelector("#status-output");
const runtimeCards = document.querySelector("#runtime-cards");
const runtimeAlerts = document.querySelector("#runtime-alerts");
const debugOutput = document.querySelector("#debug-output");
const runtimeOutput = document.querySelector("#runtime-output");
const setupWizard = document.querySelector("#setup-wizard");
const buyerSummary = document.querySelector("#buyer-summary");
const requestSummary = document.querySelector("#request-summary");
const sellerOutput = document.querySelector("#seller-output");
const sellerSubagents = document.querySelector("#seller-subagents");
const subagentFormMode = document.querySelector("#subagent-form-mode");
const catalogList = document.querySelector("#catalog-list");
const requestsList = document.querySelector("#requests-list");
const requestDetail = document.querySelector("#request-detail");
const requestOutput = document.querySelector("#request-output");
const sellerIdInput = document.querySelector("#seller-id");
const subagentIdInput = document.querySelector("#subagent-id");
const displayNameInput = document.querySelector("#display-name");
const taskTypesInput = document.querySelector("#task-types");
const capabilitiesInput = document.querySelector("#capabilities");
const tagsInput = document.querySelector("#tags");
const adapterTypeInput = document.querySelector("#adapter-type");
const adapterValueInput = document.querySelector("#adapter-value");
const addSubagentButton = document.querySelector("#add-subagent");

function opsUrl() {
  return DEFAULT_OPS_URL;
}

function savePrefs() {
  localStorage.setItem(storageKeys.buyerEmail, buyerEmailInput.value);
}

function loadPrefs() {
  buyerEmailInput.value = localStorage.getItem(storageKeys.buyerEmail) || buyerEmailInput.value;
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyBuyerFilter(items) {
  const term = buyerFilterInput.value.trim().toLowerCase();
  if (!term) {
    return items;
  }
  return items.filter((item) => JSON.stringify(item).toLowerCase().includes(term));
}

function renderBuyerSummary() {
  const status = state.status;
  setupWizard.innerHTML = renderSetupWizardMarkup(status);
  buyerSummary.innerHTML = renderBuyerSummaryCard({
    health: status?.runtime?.buyer?.health || { body: { ok: false } },
    root: {
      body: {
        service: "ops-supervisor",
        local_defaults: {
          buyer_contact_email: status?.config?.buyer?.contact_email || null,
          platform_api_key_configured: Boolean(status?.config?.buyer?.api_key)
        },
        runtime: status?.runtime || null
      }
    }
  });
  requestSummary.innerHTML = renderRequestSummaryMarkup(status?.requests || null);
}

function setSubagentForm(definition = null) {
  if (!definition) {
    state.editingSubagentId = null;
    subagentIdInput.value = "local.subagent.v1";
    displayNameInput.value = "Local Seller Runtime";
    taskTypesInput.value = "text_classify";
    capabilitiesInput.value = "text.classify";
    tagsInput.value = "local,ops";
    adapterTypeInput.value = "process";
    adapterValueInput.value = "node worker.js";
    subagentFormMode.textContent = "Creating a new local subagent.";
    addSubagentButton.textContent = "Add Subagent";
    return;
  }
  state.editingSubagentId = definition.subagent_id;
  subagentIdInput.value = definition.subagent_id || "";
  displayNameInput.value = definition.display_name || definition.subagent_id || "";
  taskTypesInput.value = (definition.task_types || []).join(", ");
  capabilitiesInput.value = (definition.capabilities || []).join(", ");
  tagsInput.value = (definition.tags || []).join(", ");
  adapterTypeInput.value = definition.adapter_type || "process";
  adapterValueInput.value = definition.adapter?.url || definition.adapter?.cmd || "";
  subagentFormMode.textContent = `Editing ${definition.subagent_id}. Save will update the local configuration.`;
  addSubagentButton.textContent = "Save Subagent";
}

function renderCatalogItems(items) {
  catalogList.innerHTML = renderCatalogItemsMarkup(items);
}

function renderRequests(items) {
  requestsList.innerHTML = renderRequestsMarkup(items);
}

function renderSelectedRequest() {
  requestDetail.innerHTML = renderRequestDetailMarkup({
    request: state.latestRequest,
    result: state.latestResult
  });
}

function renderSellerState() {
  const seller = state.status?.config?.seller || { subagents: [] };
  sellerOutput.textContent = JSON.stringify(
    {
      enabled: seller.enabled,
      seller_id: seller.seller_id,
      review_summary: state.status?.seller?.review_summary || {},
      pending_review_count: state.status?.seller?.pending_review_count || 0
    },
    null,
    2
  );
  sellerSubagents.innerHTML = renderSellerSubagentsMarkup(seller.subagents || []);
}

async function refreshRuntimeLogs() {
  runtimeOutput.textContent = "Loading runtime logs...";
  try {
    const response = await requestJson(opsUrl(), `/runtime/logs?service=${encodeURIComponent(state.runtimeService)}`);
    runtimeOutput.textContent = (response.body?.logs || []).join("").trim() || "No runtime logs yet.";
  } catch (error) {
    runtimeOutput.textContent = `Runtime logs failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function refreshRuntimeAlerts() {
  runtimeAlerts.innerHTML = `<div class="empty">Loading ${state.runtimeService} alerts...</div>`;
  try {
    const response = await requestJson(opsUrl(), `/runtime/alerts?service=${encodeURIComponent(state.runtimeService)}`);
    runtimeAlerts.innerHTML = renderRuntimeAlertsMarkup(state.runtimeService, response.body?.alerts || []);
  } catch (error) {
    runtimeAlerts.innerHTML = `<div class="empty">Runtime alerts failed: ${
      error instanceof Error ? error.message : "unknown_error"
    }</div>`;
  }
}

async function refreshDebugSnapshot() {
  debugOutput.textContent = "Loading debug snapshot...";
  try {
    const response = await requestJson(opsUrl(), "/debug/snapshot");
    debugOutput.textContent = JSON.stringify(
      {
        generated_at: response.body?.generated_at || null,
        seller: response.body?.status?.seller || null,
        requests: response.body?.status?.requests || null,
        recent_events: response.body?.recent_events || [],
        debug: response.body?.status?.debug || null
      },
      null,
      2
    );
  } catch (error) {
    debugOutput.textContent = `Debug snapshot failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function refreshStatus() {
  statusOutput.textContent = "Loading ops supervisor...";
  try {
    const status = await requestJson(opsUrl(), "/status");
    state.status = status.body;
    renderBuyerSummary();
    runtimeCards.innerHTML = renderRuntimeCardsMarkup(status.body.runtime);
    renderSellerState();
    statusOutput.textContent = JSON.stringify(status.body, null, 2);
    await refreshRuntimeAlerts();
    await refreshRuntimeLogs();
  } catch (error) {
    statusOutput.textContent = `Status refresh failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function setupClient() {
  statusOutput.textContent = "Initializing local client...";
  try {
    const response = await requestJson(opsUrl(), "/setup", { method: "POST", body: {} });
    statusOutput.textContent = JSON.stringify(response, null, 2);
    await refreshStatus();
  } catch (error) {
    statusOutput.textContent = `Setup failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function registerBuyer() {
  statusOutput.textContent = "Registering buyer...";
  try {
    const response = await requestJson(opsUrl(), "/auth/register-buyer", {
      method: "POST",
      body: { contact_email: buyerEmailInput.value.trim() }
    });
    statusOutput.textContent = JSON.stringify(response, null, 2);
    await refreshStatus();
  } catch (error) {
    statusOutput.textContent = `Buyer register failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function refreshCatalog() {
  const catalog = await requestJson(opsUrl(), "/catalog/subagents");
  state.catalogItems = catalog.body?.items || [];
  renderCatalogItems(applyBuyerFilter(state.catalogItems));
  return catalog;
}

async function refreshRequests() {
  const requests = await requestJson(opsUrl(), "/requests");
  state.requests = requests.body?.items || [];
  renderRequests(applyBuyerFilter(state.requests));
  return requests;
}

async function addSubagent() {
  sellerOutput.textContent = state.editingSubagentId ? "Saving local subagent..." : "Adding local subagent...";
  const adapterType = adapterTypeInput.value;
  const adapterValue = adapterValueInput.value.trim();
  const adapter =
    adapterType === "http"
      ? { url: adapterValue, method: "POST" }
      : { cmd: adapterValue };
  try {
    const response = await requestJson(opsUrl(), "/seller/subagents", {
      method: "POST",
      body: {
        subagent_id: subagentIdInput.value.trim(),
        display_name: displayNameInput.value.trim(),
        task_types: splitList(taskTypesInput.value),
        capabilities: splitList(capabilitiesInput.value),
        tags: splitList(tagsInput.value),
        adapter_type: adapterType,
        adapter
      }
    });
    sellerOutput.textContent = JSON.stringify(response, null, 2);
    await refreshStatus();
    setSubagentForm();
  } catch (error) {
    sellerOutput.textContent = `Add subagent failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function toggleSubagent(subagentId, enabled) {
  sellerOutput.textContent = `${enabled ? "Enabling" : "Disabling"} local subagent...`;
  try {
    const response = await requestJson(
      opsUrl(),
      `/seller/subagents/${encodeURIComponent(subagentId)}/${enabled ? "enable" : "disable"}`,
      {
        method: "POST",
        body: {}
      }
    );
    sellerOutput.textContent = JSON.stringify(response, null, 2);
    await refreshStatus();
  } catch (error) {
    sellerOutput.textContent = `${enabled ? "Enable" : "Disable"} subagent failed: ${
      error instanceof Error ? error.message : "unknown_error"
    }`;
  }
}

async function removeSubagent(subagentId) {
  sellerOutput.textContent = "Removing local subagent...";
  try {
    const response = await requestJson(opsUrl(), `/seller/subagents/${encodeURIComponent(subagentId)}`, {
      method: "DELETE"
    });
    sellerOutput.textContent = JSON.stringify(response, null, 2);
    await refreshStatus();
    if (state.editingSubagentId === subagentId) {
      setSubagentForm();
    }
  } catch (error) {
    sellerOutput.textContent = `Remove subagent failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function submitReview() {
  sellerOutput.textContent = "Submitting local subagents for review...";
  try {
    const response = await requestJson(opsUrl(), "/seller/submit-review", {
      method: "POST",
      body: {
        seller_id: document.querySelector("#seller-id").value.trim(),
        display_name: document.querySelector("#display-name").value.trim()
      }
    });
    sellerOutput.textContent = JSON.stringify(response, null, 2);
    await refreshStatus();
  } catch (error) {
    sellerOutput.textContent = `Submit review failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function enableSeller() {
  sellerOutput.textContent = "Enabling seller...";
  try {
    const response = await requestJson(opsUrl(), "/seller/enable", {
      method: "POST",
      body: {
        seller_id: document.querySelector("#seller-id").value.trim(),
        display_name: document.querySelector("#display-name").value.trim()
      }
    });
    sellerOutput.textContent = JSON.stringify(response, null, 2);
    await refreshStatus();
  } catch (error) {
    sellerOutput.textContent = `Enable seller failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function loadFirstCatalogItem() {
  const catalog = await refreshCatalog();
  const item = catalog.body?.items?.[0];
  if (!item) {
    return;
  }
  document.querySelector("#request-seller-id").value = item.seller_id || "";
  document.querySelector("#request-subagent-id").value = item.subagent_id || "";
  document.querySelector("#request-task-type").value = item.task_types?.[0] || "text_classify";
}

async function dispatchRequest() {
  requestOutput.textContent = "Dispatching remote request...";
  try {
    const payloadText = document.querySelector("#request-text").value.trim();
    const response = await requestJson(opsUrl(), "/requests", {
      method: "POST",
      body: {
        seller_id: document.querySelector("#request-seller-id").value.trim(),
        subagent_id: document.querySelector("#request-subagent-id").value.trim(),
        task_type: document.querySelector("#request-task-type").value.trim(),
        input: { text: payloadText },
        payload: { text: payloadText },
        output_schema: {
          type: "object",
          properties: {
            summary: { type: "string" }
          }
        }
      }
    });
    requestOutput.textContent = JSON.stringify(response, null, 2);
    if (response.status === 201 && response.body?.request_id) {
      state.latestRequestId = response.body.request_id;
      state.latestRequest = response.body.request || { request_id: response.body.request_id, status: "SENT" };
      state.latestResult = null;
      renderSelectedRequest();
      startResultPolling();
      await refreshRequests();
    }
  } catch (error) {
    requestOutput.textContent = `Dispatch failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

async function fetchResult() {
  if (!state.latestRequestId) {
    requestOutput.textContent = "No request id available yet.";
    return;
  }
  try {
    const result = await requestJson(opsUrl(), `/requests/${state.latestRequestId}/result`);
    const request = await requestJson(opsUrl(), `/requests/${state.latestRequestId}`);
    state.latestRequest = request.body || null;
    state.latestResult = result.body || null;
    renderSelectedRequest();
    requestOutput.textContent = JSON.stringify({ request, result }, null, 2);
    if (result.body?.available) {
      stopResultPolling();
    }
  } catch (error) {
    requestOutput.textContent = `Result fetch failed: ${error instanceof Error ? error.message : "unknown_error"}`;
  }
}

function stopResultPolling() {
  if (state.resultPollTimer) {
    clearInterval(state.resultPollTimer);
    state.resultPollTimer = null;
  }
}

function startResultPolling() {
  stopResultPolling();
  state.resultPollTimer = setInterval(() => {
    void fetchResult();
  }, 1000);
}

document.querySelector("#refresh-status").addEventListener("click", refreshStatus);
document.querySelector("#setup-client").addEventListener("click", setupClient);
document.querySelector("#register-buyer").addEventListener("click", registerBuyer);
document.querySelector("#refresh-runtime").addEventListener("click", refreshRuntimeLogs);
document.querySelector("#debug-snapshot").addEventListener("click", refreshDebugSnapshot);
document.querySelector("#refresh-catalog").addEventListener("click", refreshCatalog);
document.querySelector("#refresh-requests").addEventListener("click", refreshRequests);
document.querySelector("#add-subagent").addEventListener("click", addSubagent);
document.querySelector("#reset-subagent-form").addEventListener("click", () => setSubagentForm());
document.querySelector("#submit-review").addEventListener("click", submitReview);
document.querySelector("#enable-seller").addEventListener("click", enableSeller);
document.querySelector("#load-first-catalog").addEventListener("click", loadFirstCatalogItem);
document.querySelector("#dispatch-request").addEventListener("click", dispatchRequest);
document.querySelector("#poll-result").addEventListener("click", fetchResult);
setupWizard.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-wizard-action]");
  if (!button) {
    return;
  }
  const action = button.dataset.wizardAction;
  if (action === "setup") {
    await setupClient();
    return;
  }
  if (action === "register-buyer") {
    await registerBuyer();
    return;
  }
  if (action === "focus-subagent-form") {
    subagentIdInput.focus();
    return;
  }
  if (action === "submit-review") {
    await submitReview();
    return;
  }
  if (action === "enable-seller") {
    await enableSeller();
  }
});
runtimeServiceInput.addEventListener("change", () => {
  state.runtimeService = runtimeServiceInput.value;
  void refreshRuntimeAlerts();
  void refreshRuntimeLogs();
});
requestsList.addEventListener("click", async (event) => {
  const card = event.target.closest("[data-request-id]");
  if (!card) {
    return;
  }
  state.latestRequestId = card.dataset.requestId;
  await fetchResult();
});
sellerSubagents.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-subagent-action]");
  if (!button) {
    return;
  }
  const subagentId = button.dataset.subagentId;
  const action = button.dataset.subagentAction;
  if (!subagentId || !action) {
    return;
  }
  if (action === "edit") {
    const subagent = state.status?.config?.seller?.subagents?.find((item) => item.subagent_id === subagentId);
    if (subagent) {
      setSubagentForm(subagent);
    }
    return;
  }
  if (action === "remove") {
    await removeSubagent(subagentId);
    return;
  }
  await toggleSubagent(subagentId, action === "enable");
});
buyerFilterInput.addEventListener("input", () => {
  if (state.requests.length > 0) {
    renderRequests(applyBuyerFilter(state.requests));
  }
  if (state.catalogItems.length > 0) {
    renderCatalogItems(applyBuyerFilter(state.catalogItems));
  }
});
buyerEmailInput.addEventListener("change", savePrefs);

loadPrefs();
setSubagentForm();
renderSelectedRequest();
void refreshStatus();
void refreshDebugSnapshot();
void refreshCatalog();
void refreshRequests();
