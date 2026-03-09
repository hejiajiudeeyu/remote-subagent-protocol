import { describe, expect, it } from "vitest";

import { canonicalizeResultPackageForSignature } from "@croc/contracts";

describe("canonicalizeResultPackageForSignature (extended)", () => {
  it("returns empty object for undefined input", () => {
    expect(canonicalizeResultPackageForSignature()).toEqual({});
  });

  it("returns empty object for empty object input", () => {
    expect(canonicalizeResultPackageForSignature({})).toEqual({});
  });

  it("includes error field when present", () => {
    const result = canonicalizeResultPackageForSignature({
      request_id: "req_1",
      status: "error",
      error: { code: "AUTH_TOKEN_EXPIRED", message: "expired" }
    });

    expect(result).toEqual({
      request_id: "req_1",
      status: "error",
      error: { code: "AUTH_TOKEN_EXPIRED", message: "expired" }
    });
  });

  it("includes usage field when present", () => {
    const result = canonicalizeResultPackageForSignature({
      request_id: "req_1",
      status: "ok",
      output: { summary: "done" },
      usage: { tokens_in: 42, tokens_out: 24 }
    });

    expect(result.usage).toEqual({ tokens_in: 42, tokens_out: 24 });
  });

  it("preserves only canonical keys and ignores all others", () => {
    const result = canonicalizeResultPackageForSignature({
      request_id: "req_1",
      result_version: "0.1.0",
      seller_id: "s1",
      subagent_id: "a1",
      status: "ok",
      output: {},
      error: null,
      timing: { elapsed_ms: 5 },
      usage: { tokens_in: 1, tokens_out: 1 },
      signature_algorithm: "Ed25519",
      signature_base64: "xxx",
      signature_valid: true,
      schema_valid: true,
      extra: true
    });

    expect(Object.keys(result).sort()).toEqual(
      ["error", "output", "request_id", "result_version", "seller_id", "status", "subagent_id", "timing", "usage"]
    );
  });

  it("handles result with only request_id", () => {
    const result = canonicalizeResultPackageForSignature({
      request_id: "req_1"
    });
    expect(result).toEqual({ request_id: "req_1" });
  });

  it("preserves nested objects by reference", () => {
    const output = { nested: { deep: true } };
    const result = canonicalizeResultPackageForSignature({
      request_id: "req_1",
      status: "ok",
      output
    });
    expect(result.output).toBe(output);
  });
});
