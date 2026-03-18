/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body, status = 200) {
  return {
    status,
    async text() {
      return JSON.stringify(body);
    }
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ops-console dom flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("renders requests and selected request detail through supervisor-only flow", async () => {
    document.body.innerHTML = `<div id="app"></div>`;
    let transportConfig = {
      type: "local",
      relay_http: { base_url: "http://127.0.0.1:8090" },
      email: {
        provider: "emailengine",
        sender: "",
        receiver: "",
        poll_interval_ms: 5000,
        emailengine: {
          base_url: "",
          account: "",
          access_token_configured: false
        },
        gmail: {
          client_id: "",
          user: "",
          client_secret_configured: false,
          refresh_token_configured: false
        }
      }
    };
    let localSubagents = [
      {
        subagent_id: "local.subagent.v2",
        display_name: "Local One",
        task_types: ["text_classify"],
        capabilities: ["text.classify"],
        tags: ["local"],
        adapter_type: "process",
        adapter: { cmd: "node worker.js" },
        enabled: true,
        review_status: "pending",
        submitted_for_review: true
      }
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init = {}) => {
        const url = typeof input === "string" ? new URL(input) : input;
        const pathname = url.pathname;
        const method = init.method || "GET";

        if (pathname === "/auth/session" && method === "GET") {
          return jsonResponse({
            session: {
              setup_required: false,
              authenticated: true,
              legacy_secret_source_present: false,
              legacy_secret_keys: [],
              expires_at: "2026-03-17T00:00:00.000Z"
            }
          });
        }
        if (pathname === "/status") {
          return jsonResponse({
            config: {
              buyer: { api_key: null, api_key_configured: true, contact_email: "buyer@test.local" },
              seller: {
                enabled: false,
                seller_id: "seller_local",
                subagents: localSubagents
              }
            },
            seller: {
              enabled: false,
              pending_review_count: 0,
              review_summary: { pending: 1 }
            },
            requests: { total: 1, by_status: { SUCCEEDED: 1 }, latest: [] },
            runtime: {
              buyer: { health: { status: 200, body: { ok: true } } },
              seller: { health: null },
              relay: { health: { status: 200, body: { ok: true } } }
            }
          });
        }
        if (pathname === "/runtime/logs" && method === "GET") {
          return jsonResponse({ service: "buyer", logs: ["buyer ready\n"] });
        }
        if (pathname === "/runtime/transport" && method === "GET") {
          return jsonResponse(transportConfig);
        }
        if (pathname === "/runtime/transport" && method === "PUT") {
          const body = JSON.parse(init.body || "{}");
          transportConfig = {
            ...transportConfig,
            type: body.type,
            relay_http: {
              base_url: body.relay_http?.base_url || ""
            },
            email: {
              provider: body.email?.provider || "emailengine",
              sender: body.email?.sender || "",
              receiver: body.email?.receiver || "",
              poll_interval_ms: body.email?.poll_interval_ms || 5000,
              emailengine: {
                base_url: body.email?.emailengine?.base_url || "",
                account: body.email?.emailengine?.account || "",
                access_token_configured: Boolean(body.email?.emailengine?.access_token)
              },
              gmail: {
                client_id: body.email?.gmail?.client_id || "",
                user: body.email?.gmail?.user || "",
                client_secret_configured: Boolean(body.email?.gmail?.client_secret),
                refresh_token_configured: Boolean(body.email?.gmail?.refresh_token)
              }
            }
          };
          return jsonResponse(transportConfig);
        }
        if (pathname === "/runtime/transport/test" && method === "POST") {
          return jsonResponse({
            ok: true,
            kind: transportConfig.type === "email" ? transportConfig.email.provider : transportConfig.type,
            detail: "test_ok"
          });
        }
        if (pathname === "/runtime/alerts" && method === "GET") {
          return jsonResponse({
            service: "buyer",
            alerts: [
              {
                service: "buyer",
                severity: "warning",
                source: "log",
                message: "warning: buyer retry scheduled"
              }
            ]
          });
        }
        if (pathname === "/debug/snapshot" && method === "GET") {
          return jsonResponse({
            ok: true,
            generated_at: "2026-03-09T00:00:00.000Z",
            status: {
              seller: { enabled: false, review_summary: { pending: 1 } },
              requests: { total: 1, by_status: { SUCCEEDED: 1 } },
              debug: { logs_dir: "/tmp/ops/logs", event_log: "/tmp/ops/logs/supervisor.events.jsonl" }
            },
            recent_events: [{ type: "service_started", service: "buyer" }]
          });
        }
        if (pathname === "/catalog/subagents" && method === "GET") {
          return jsonResponse({ items: [] });
        }
        if (pathname === "/seller/subagents" && method === "POST") {
          const body = JSON.parse(init.body || "{}");
          const nextSubagent = {
            subagent_id: body.subagent_id,
            display_name: body.display_name,
            task_types: body.task_types || [],
            capabilities: body.capabilities || [],
            tags: body.tags || [],
            adapter_type: body.adapter_type || "process",
            adapter: body.adapter || { cmd: "node worker.js" },
            enabled: true,
            review_status: "local_only",
            submitted_for_review: false
          };
          localSubagents = [
            ...localSubagents.filter((item) => item.subagent_id !== nextSubagent.subagent_id),
            nextSubagent
          ];
          return jsonResponse({
            ...nextSubagent
          }, 201);
        }
        if (pathname === "/seller/subagents/example" && method === "POST") {
          const nextSubagent = {
            subagent_id: "local.summary.v1",
            display_name: "Local Summary Example",
            task_types: ["text_summarize"],
            capabilities: ["text.summarize"],
            tags: ["local", "example", "demo"],
            adapter_type: "process",
            adapter: { cmd: `${process.execPath} example-subagent-worker.js` },
            enabled: true,
            review_status: "local_only",
            submitted_for_review: false
          };
          localSubagents = [
            ...localSubagents.filter((item) => item.subagent_id !== nextSubagent.subagent_id),
            nextSubagent
          ];
          return jsonResponse({
            ...nextSubagent,
            example: true
          }, 201);
        }
        if (pathname === "/seller/subagents/local.subagent.v2/disable" && method === "POST") {
          localSubagents = localSubagents.map((item) =>
            item.subagent_id === "local.subagent.v2" ? { ...item, enabled: false } : item
          );
          return jsonResponse({
            ok: true,
            subagent_id: "local.subagent.v2",
            enabled: false,
            review_status: "pending",
            submitted_for_review: true
          });
        }
        if (pathname === "/seller/subagents/local.subagent.v2" && method === "DELETE") {
          localSubagents = localSubagents.filter((item) => item.subagent_id !== "local.subagent.v2");
          return jsonResponse({
            ok: true,
            removed: {
              subagent_id: "local.subagent.v2"
            }
          });
        }
        if (pathname === "/seller/submit-review" && method === "POST") {
          return jsonResponse({ seller_id: "seller_local", submitted: 1, results: [{ review_status: "pending" }] }, 201);
        }
        if (pathname === "/requests" && method === "GET") {
          return jsonResponse({
            items: [
              {
                request_id: "req_ui_1",
                seller_id: "seller_foxlab",
                subagent_id: "foxlab.text.classifier.v1",
                status: "SUCCEEDED",
                updated_at: "2026-03-08T00:00:00Z"
              }
            ]
          });
        }
        if (pathname === "/requests/req_ui_1") {
          return jsonResponse({
            request_id: "req_ui_1",
            seller_id: "seller_foxlab",
            subagent_id: "foxlab.text.classifier.v1",
            status: "SUCCEEDED",
            updated_at: "2026-03-08T00:00:00Z"
          });
        }
        if (pathname === "/requests/req_ui_1/result") {
          return jsonResponse({
            available: true,
            result_package: {
              status: "ok",
              output: { summary: "dom flow ok" }
            }
          });
        }
        if (pathname === "/requests/example" && method === "POST") {
          return jsonResponse({
            request_id: "req_example_1",
            request: {
              request_id: "req_example_1",
              seller_id: "seller_local",
              subagent_id: "local.summary.v1",
              status: "SENT",
              updated_at: "2026-03-08T00:00:01Z"
            }
          }, 201);
        }
        if (pathname === "/requests/req_example_1") {
          return jsonResponse({
            request_id: "req_example_1",
            seller_id: "seller_local",
            subagent_id: "local.summary.v1",
            status: "SUCCEEDED",
            updated_at: "2026-03-08T00:00:02Z"
          });
        }
        if (pathname === "/requests/req_example_1/result") {
          return jsonResponse({
            available: true,
            result_package: {
              status: "ok",
              output: { summary: "local demo ok" }
            }
          });
        }
        return jsonResponse({ items: [] });
      })
    );

    await import("../../apps/ops-console/src/main.js");
    await flush();

    expect(document.querySelector("#ops-url")).toBeNull();
    expect(document.querySelector("#requests-list")?.textContent).toContain("req_ui_1");
    expect(document.querySelector("#runtime-output")?.textContent).toContain("buyer ready");
    expect(document.querySelector("#runtime-alerts")?.textContent).toContain("buyer retry scheduled");
    expect(document.querySelector("#debug-output")?.textContent).toContain("/tmp/ops/logs");
    expect(document.querySelector("#request-summary")?.textContent).toContain("SUCCEEDED: 1");
    expect(document.querySelector("#transport-summary")?.textContent).toContain("type=local");
    expect(document.querySelector("#setup-wizard")?.textContent).toContain("Register Buyer");
    expect(document.querySelector("#setup-wizard")?.textContent).toContain("Add Local Example");
    expect(document.querySelector("[data-wizard-action='register-buyer']")?.textContent).toContain("Review");
    expect(document.querySelector("#setup-wizard")?.textContent).toContain("Submitted: 1");
    document.querySelector("#add-example-subagent")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#seller-subagents")?.textContent).toContain("Local Summary Example");
    document.querySelector("#transport-type").value = "email";
    document.querySelector("#transport-type")?.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#transport-email-provider").value = "gmail";
    document.querySelector("#transport-email-provider")?.dispatchEvent(new Event("change", { bubbles: true }));
    document.querySelector("#transport-email-sender").value = "buyer@example.com";
    document.querySelector("#transport-email-receiver").value = "seller@example.com";
    document.querySelector("#transport-gmail-client-id").value = "gmail-client-id";
    document.querySelector("#transport-gmail-user").value = "buyer@example.com";
    document.querySelector("#transport-gmail-client-secret").value = "secret";
    document.querySelector("#transport-gmail-refresh-token").value = "refresh";
    document.querySelector("#save-transport")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#transport-summary")?.textContent).toContain("provider=gmail");
    expect(document.querySelector("#transport-summary")?.textContent).toContain("client_secret=configured");
    document.querySelector("#test-transport")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#transport-summary")?.textContent).toContain("test_ok");
    document
      .querySelector("[data-subagent-action='edit'][data-subagent-id='local.subagent.v2']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#subagent-id")?.value).toBe("local.subagent.v2");
    expect(document.querySelector("#add-subagent")?.textContent).toContain("Save");
    document.querySelector("#display-name").value = "Local One Updated";
    document.querySelector("#add-subagent")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#seller-subagents")?.textContent).toContain("Local One Updated");
    document
      .querySelector("[data-subagent-action='disable'][data-subagent-id='local.subagent.v2']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#seller-output")?.textContent).toContain("\"enabled\": false");
    document
      .querySelector("[data-subagent-action='remove'][data-subagent-id='local.subagent.v2']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#seller-subagents")?.textContent).not.toContain("local.subagent.v2");
    document.querySelector("[data-request-id='req_ui_1']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#request-detail")?.textContent).toContain("dom flow ok");
    expect(document.querySelector("#request-detail")?.textContent).toContain("Result Summary");
    document.querySelector("#run-example-request")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    document.querySelector("#poll-result")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#request-detail")?.textContent).toContain("local demo ok");
  });
});
