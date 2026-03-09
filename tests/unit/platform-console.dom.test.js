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

describe("platform-console dom flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("renders admin lists and selection detail", async () => {
    document.body.innerHTML = `<div id="app"></div>`;
    let lastActionReason = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init = {}) => {
        const url = typeof input === "string" ? new URL(input) : input;
        const pathname = url.pathname;
        const params = url.searchParams;

        if (pathname === "/healthz") {
          return jsonResponse({ ok: true, service: "platform-api" });
        }
        if (pathname === "/v1/metrics/summary") {
          return jsonResponse({ total_events: 2, by_type: { "seller.disabled": 1 } });
        }
        if (pathname === "/v1/admin/sellers") {
          return jsonResponse({
            items: [{ seller_id: "seller_a", contact_email: "a@test.local", subagent_count: 1, status: "disabled" }],
            pagination: { total: 1, limit: Number(params.get("limit") || 8), offset: 0, has_more: false }
          });
        }
        if (pathname === "/v1/admin/subagents") {
          return jsonResponse({
            items: [{ subagent_id: "subagent_a", display_name: "Subagent A", capabilities: ["text.classify"], status: "disabled" }],
            pagination: { total: 1, limit: Number(params.get("limit") || 8), offset: 0, has_more: false }
          });
        }
        if (pathname === "/v1/admin/requests") {
          return jsonResponse({
            items: [{ request_id: "req_admin_1", event_count: 1, latest_event: { event_type: "ACKED" } }],
            pagination: { total: 1, limit: Number(params.get("limit") || 8), offset: 0, has_more: false }
          });
        }
        if (pathname === "/v1/catalog/subagents") {
          return jsonResponse({ items: [{ subagent_id: "subagent_a" }] });
        }
        if (pathname === "/v1/admin/audit-events") {
          return jsonResponse({
            items: [{ id: "audit_1", action: "seller.disabled", target_type: "seller", target_id: "seller_a", actor_type: "admin", recorded_at: "now", reason: "policy" }],
            pagination: { total: 1, limit: Number(params.get("limit") || 8), offset: 0, has_more: false }
          });
        }
        if (pathname === "/v1/admin/reviews") {
          return jsonResponse({
            items: [{ id: "review_1", target_type: "seller", target_id: "seller_a", review_status: "pending", actor_type: "buyer", recorded_at: "now", reason: "awaiting review" }],
            pagination: { total: 1, limit: Number(params.get("limit") || 8), offset: 0, has_more: false }
          });
        }
        if (pathname.endsWith("/approve") || pathname.endsWith("/reject") || pathname.endsWith("/disable")) {
          lastActionReason = JSON.parse(init.body || "{}").reason;
          return jsonResponse({ ok: true });
        }
        return jsonResponse({});
      })
    );

    await import("../../apps/platform-console/src/main.js");
    await flush();

    expect(document.querySelector("#sellers-page")?.textContent).toContain("1-1 / 1");
    document.querySelector("#section-filter").value = "sellers";
    document.querySelector("#section-filter")?.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(document.querySelector("#requests-list")?.textContent).toContain("hidden by section filter");
    document.querySelector("[data-detail-id='seller_a']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(document.querySelector("#detail-output")?.textContent).toContain("seller_a");
    expect(document.querySelector("#reviewer-guidance")?.textContent).toContain("Reviewer Guidance");
    expect(document.querySelector("#review-action-summary")?.textContent).toContain("Latest reason: awaiting review");
    expect(document.querySelector("#detail-summary")?.textContent).toContain("disabled");
    expect(document.querySelector("#detail-history")?.textContent).toContain("Review History");
    expect(document.querySelector("#detail-history")?.textContent).toContain("Audit History");
    document.querySelector("#reviewer-notes").value = "manual reviewer note";
    document.querySelector("#reviewer-notes")?.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("[data-type='sellers'][data-action='approve']")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    expect(lastActionReason).toBe("manual reviewer note");
  });
});
