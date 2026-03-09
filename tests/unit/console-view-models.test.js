import { describe, expect, it } from "vitest";

import {
  renderBuyerSummaryCard,
  renderCatalogItemsMarkup,
  renderRequestDetailMarkup,
  renderRequestsMarkup,
  renderRuntimeCardsMarkup,
  renderSetupWizardMarkup,
  renderSellerSubagentsMarkup
} from "../../apps/ops-console/src/view-model.js";
import {
  renderAdminRequestCardsMarkup,
  renderAuditCardsMarkup,
  renderDetailSummary,
  renderEntityCardsMarkup,
  renderHistorySummary,
  renderPaginationSummary,
  renderReviewActionSummary,
  renderReviewCardsMarkup
} from "../../apps/platform-console/src/view-model.js";

describe("console view models", () => {
  it("renders ops request detail summary", () => {
    const markup = renderRequestDetailMarkup({
      request: {
        request_id: "req_1",
        seller_id: "seller_1",
        subagent_id: "subagent_1",
        status: "SUCCEEDED",
        updated_at: "2026-03-08T00:00:00Z"
      },
      result: {
        available: true,
        result_package: {
          status: "ok",
          output: { summary: "classification complete" }
        }
      }
    });
    expect(markup).toContain("req_1");
    expect(markup).toContain("classification complete");
    expect(markup).toContain("SUCCEEDED");
    expect(markup).toContain("Result Payload");
    expect(markup).toContain("Timeline");
    expect(markup).toContain("Result Summary");
    expect(renderSetupWizardMarkup({ config: { buyer: { api_key: "sk" }, seller: { enabled: false, subagents: [] } }, runtime: { supervisor: { port: 1 } } })).toContain("Register Buyer");
    expect(renderSetupWizardMarkup({ config: { buyer: {}, seller: { enabled: false, subagents: [] } }, runtime: { supervisor: { port: 1 } } })).toContain("Blocked:");
  });

  it("renders ops collections", () => {
    expect(renderBuyerSummaryCard({ health: { body: { ok: true } }, root: { body: { service: "buyer-controller" } } })).toContain(
      "buyer-controller"
    );
    expect(
      renderCatalogItemsMarkup([{ subagent_id: "s1", seller_id: "seller", capabilities: ["text.classify"] }])
    ).toContain("text.classify");
    expect(renderRequestsMarkup([{ request_id: "req_2", status: "SENT" }])).toContain("req_2");
    const sellerMarkup = renderSellerSubagentsMarkup([{ subagent_id: "local.s1", adapter_type: "process", review_status: "pending" }]);
    expect(sellerMarkup).toContain("pending");
    expect(sellerMarkup).toContain("Disable");
    expect(sellerMarkup).toContain("Remove");
    expect(
      renderRuntimeCardsMarkup({
        buyer: { running: true, pid: 100, health: { body: { ok: true } } },
        seller: { running: false, pid: null, health: null },
        relay: { running: true, pid: 101, health: { body: { ok: false } } }
      })
    ).toContain("buyer");
  });

  it("renders platform collections and pagination summary", () => {
    expect(renderEntityCardsMarkup([{ seller_id: "seller_a", subagent_count: 2, status: "disabled" }], "sellers")).toContain(
      "Approve"
    );
    expect(renderAdminRequestCardsMarkup([{ request_id: "req_a", event_count: 1 }])).toContain("req_a");
    expect(renderAuditCardsMarkup([{ id: "audit_1", action: "seller.disabled", target_type: "seller", target_id: "seller_a", actor_type: "admin", recorded_at: "now" }])).toContain("seller.disabled");
    expect(renderReviewCardsMarkup([{ id: "review_1", target_type: "seller", target_id: "seller_a", review_status: "pending", actor_type: "buyer", recorded_at: "now" }])).toContain("pending");
    expect(renderPaginationSummary({ total: 24, offset: 10, limit: 10 }, "sellers")).toBe("sellers: 11-20 / 24");
    expect(renderDetailSummary({ seller_id: "seller_a", status: "disabled" })).toContain("seller_a");
    expect(renderHistorySummary([{ review_status: "pending", recorded_at: "now" }], "Review History")).toContain("Review History");
    expect(renderReviewActionSummary({ seller_id: "seller_a", status: "disabled" }, "manual check", [{ reason: "policy" }])).toContain("manual check");
  });
});
