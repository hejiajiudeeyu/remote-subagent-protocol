import { describe, expect, it } from "vitest";

import { canonicalizeResultPackageForSignature, ERROR_DOMAIN, REQUEST_STATUS } from "@delexec/contracts";

describe("@delexec/contracts", () => {
  it("contains MVP request statuses", () => {
    expect(REQUEST_STATUS).toMatchObject({
      CREATED: "CREATED",
      ACKED: "ACKED",
      SUCCEEDED: "SUCCEEDED",
      TIMED_OUT: "TIMED_OUT",
      UNVERIFIED: "UNVERIFIED"
    });
  });

  it("contains stable error domains", () => {
    expect(Object.values(ERROR_DOMAIN)).toEqual(
      expect.arrayContaining(["AUTH", "CONTRACT", "EXEC", "RESULT", "DELIVERY", "TEMPLATE", "PLATFORM"])
    );
  });

  it("canonicalizes only signable result fields", () => {
    expect(
      canonicalizeResultPackageForSignature({
        message_type: "remote_subagent_result",
        request_id: "req_1",
        result_version: "0.1.0",
        seller_id: "seller_foxlab",
        subagent_id: "foxlab.text.classifier.v1",
        verification: { display_code: "CODE123" },
        status: "ok",
        output: { summary: "done" },
        artifacts: [{ name: "report.pdf", sha256: "abc" }],
        timing: { elapsed_ms: 10 },
        signature_algorithm: "Ed25519",
        signature_base64: "x",
        extra_field: true
      })
    ).toEqual({
      message_type: "remote_subagent_result",
      request_id: "req_1",
      result_version: "0.1.0",
      seller_id: "seller_foxlab",
      subagent_id: "foxlab.text.classifier.v1",
      verification: { display_code: "CODE123" },
      status: "ok",
      output: { summary: "done" },
      artifacts: [{ name: "report.pdf", sha256: "abc" }],
      timing: { elapsed_ms: 10 }
    });
  });
});
