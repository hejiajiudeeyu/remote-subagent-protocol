import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalizeResultPackageForSignature } from "@delexec/contracts";
import {
  applyResultPackage,
  createRequestRecord,
  evaluateTimeouts,
  loadBuyerConfig
} from "@delexec/buyer-controller-core";

function makeRequest(overrides = {}) {
  const now = Date.now();
  return {
    request_id: "req_test",
    buyer_id: "buyer_1",
    seller_id: "seller_1",
    subagent_id: "agent.v1",
    status: "CREATED",
    timeout_decision: "pending",
    needs_timeout_confirmation: false,
    acknowledged_at: null,
    ack_deadline_at: null,
    soft_timeout_at: new Date(now + 90_000).toISOString(),
    hard_timeout_at: new Date(now + 300_000).toISOString(),
    expected_signer_public_key_pem: null,
    timeline: [{ at: new Date(now).toISOString(), event: "CREATED" }],
    updated_at: new Date(now).toISOString(),
    result_package: null,
    last_error_code: null,
    ...overrides
  };
}

function makeConfig(overrides = {}) {
  return {
    timeout_confirmation_mode: "ask_by_default",
    hard_timeout_auto_finalize: true,
    ...overrides
  };
}

function generateKeyPair() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
}

function signResult(result, privateKeyPem) {
  const canonical = canonicalizeResultPackageForSignature(result);
  const bytes = Buffer.from(JSON.stringify(canonical), "utf8");
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, bytes, privateKey).toString("base64");
}

// --- evaluateTimeouts ---

describe("evaluateTimeouts", () => {
  it("returns null for terminal status", () => {
    for (const status of ["SUCCEEDED", "FAILED", "UNVERIFIED", "TIMED_OUT"]) {
      const request = makeRequest({
        status,
        hard_timeout_at: new Date(Date.now() - 1000).toISOString()
      });
      expect(evaluateTimeouts(request, makeConfig())).toBeNull();
    }
  });

  it("triggers ack deadline timeout for SENT without ACK", () => {
    const request = makeRequest({
      status: "SENT",
      ack_deadline_at: new Date(Date.now() - 1000).toISOString()
    });

    const result = evaluateTimeouts(request, makeConfig());
    expect(result).toEqual({
      status: "TIMED_OUT",
      eventType: "buyer.request.timed_out",
      code: "DELIVERY_OR_ACCEPTANCE_TIMEOUT"
    });
    expect(request.status).toBe("TIMED_OUT");
  });

  it("skips ack deadline timeout when already acknowledged", () => {
    const request = makeRequest({
      status: "SENT",
      ack_deadline_at: new Date(Date.now() - 1000).toISOString(),
      acknowledged_at: new Date().toISOString()
    });

    const result = evaluateTimeouts(request, makeConfig());
    expect(result).toBeNull();
    expect(request.status).toBe("SENT");
  });

  it("skips ack deadline timeout when continue_wait decision", () => {
    const request = makeRequest({
      status: "SENT",
      ack_deadline_at: new Date(Date.now() - 1000).toISOString(),
      timeout_decision: "continue_wait"
    });

    const result = evaluateTimeouts(request, makeConfig());
    expect(result).toBeNull();
  });

  it("sets needs_timeout_confirmation on soft timeout in ask_by_default mode", () => {
    const request = makeRequest({
      status: "ACKED",
      soft_timeout_at: new Date(Date.now() - 1000).toISOString(),
      hard_timeout_at: new Date(Date.now() + 60_000).toISOString(),
      timeout_decision: "pending"
    });

    const result = evaluateTimeouts(request, makeConfig());
    expect(result).toBeNull();
    expect(request.needs_timeout_confirmation).toBe(true);
  });

  it("does not set needs_timeout_confirmation when decision is not pending", () => {
    const request = makeRequest({
      status: "ACKED",
      soft_timeout_at: new Date(Date.now() - 1000).toISOString(),
      hard_timeout_at: new Date(Date.now() + 60_000).toISOString(),
      timeout_decision: "continue_wait"
    });

    evaluateTimeouts(request, makeConfig());
    expect(request.needs_timeout_confirmation).toBe(false);
  });

  it("triggers hard timeout for active requests", () => {
    for (const status of ["CREATED", "SENT", "ACKED"]) {
      const request = makeRequest({
        status,
        hard_timeout_at: new Date(Date.now() - 1000).toISOString()
      });

      const result = evaluateTimeouts(request, makeConfig());
      expect(result).toEqual({
        status: "TIMED_OUT",
        eventType: "buyer.request.timed_out",
        code: "EXEC_TIMEOUT_HARD"
      });
    }
  });

  it("skips hard timeout when continue_wait decision", () => {
    const request = makeRequest({
      status: "ACKED",
      hard_timeout_at: new Date(Date.now() - 1000).toISOString(),
      timeout_decision: "continue_wait"
    });

    const result = evaluateTimeouts(request, makeConfig());
    expect(result).toBeNull();
  });

  it("skips hard timeout when hard_timeout_auto_finalize is false", () => {
    const request = makeRequest({
      status: "ACKED",
      hard_timeout_at: new Date(Date.now() - 1000).toISOString()
    });

    const result = evaluateTimeouts(request, makeConfig({ hard_timeout_auto_finalize: false }));
    expect(result).toBeNull();
  });

  it("returns null when no timeouts reached", () => {
    const request = makeRequest({ status: "ACKED" });
    const result = evaluateTimeouts(request, makeConfig());
    expect(result).toBeNull();
  });

  it("ack deadline takes priority over hard timeout for SENT status", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const request = makeRequest({
      status: "SENT",
      ack_deadline_at: past,
      hard_timeout_at: past
    });

    const result = evaluateTimeouts(request, makeConfig());
    expect(result.code).toBe("DELIVERY_OR_ACCEPTANCE_TIMEOUT");
  });
});

// --- applyResultPackage ---

describe("applyResultPackage", () => {
  it("returns SUCCEEDED for valid ok result without signature", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: { summary: "done" },
      schema_valid: true
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.eventType).toBe("buyer.request.succeeded");
    expect(request.status).toBe("SUCCEEDED");
    expect(request.last_error_code).toBeNull();
  });

  it("returns FAILED for error result", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "error",
      error: { code: "AUTH_TOKEN_EXPIRED", message: "expired", retryable: false },
      schema_valid: true
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("FAILED");
    expect(result.code).toBe("AUTH_TOKEN_EXPIRED");
    expect(request.last_error_code).toBe("AUTH_TOKEN_EXPIRED");
  });

  it("returns UNVERIFIED for context mismatch (wrong request_id)", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_wrong",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: {}
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_CONTEXT_MISMATCH");
  });

  it("returns UNVERIFIED for context mismatch (wrong seller_id)", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_wrong",
      subagent_id: "agent.v1",
      status: "ok",
      output: {}
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_CONTEXT_MISMATCH");
  });

  it("returns UNVERIFIED for context mismatch (wrong subagent_id)", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "wrong.agent",
      status: "ok",
      output: {}
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_CONTEXT_MISMATCH");
  });

  it("returns UNVERIFIED for wrong result_version", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "99.0.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: {}
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_CONTEXT_MISMATCH");
  });

  it("allows null seller_id on request (wildcard match)", () => {
    const request = makeRequest({ status: "ACKED", seller_id: null });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "any_seller",
      subagent_id: "agent.v1",
      status: "ok",
      output: { summary: "ok" },
      schema_valid: true
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("allows null subagent_id on request (wildcard match)", () => {
    const request = makeRequest({ status: "ACKED", subagent_id: null });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "any.agent",
      status: "ok",
      output: { summary: "ok" },
      schema_valid: true
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("returns UNVERIFIED for schema_valid=false", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: {},
      schema_valid: false
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_SCHEMA_INVALID");
  });

  it("returns UNVERIFIED for invalid signature", () => {
    const { publicKey } = generateKeyPair();
    const request = makeRequest({
      status: "ACKED",
      expected_signer_public_key_pem: publicKey
    });

    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: { summary: "tampered" },
      signature_algorithm: "Ed25519",
      signature_base64: Buffer.from("invalid-signature").toString("base64")
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_SIGNATURE_INVALID");
  });

  it("returns UNVERIFIED when signature present but no expected public key", () => {
    const request = makeRequest({
      status: "ACKED",
      expected_signer_public_key_pem: null
    });

    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: {},
      signature_base64: "c29tZQ=="
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_SIGNATURE_INVALID");
  });

  it("accepts valid Ed25519 signature", () => {
    const { publicKey, privateKey } = generateKeyPair();
    const request = makeRequest({
      status: "ACKED",
      expected_signer_public_key_pem: publicKey
    });

    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: { summary: "signed result" },
      schema_valid: true,
      signature_algorithm: "Ed25519"
    };

    body.signature_base64 = signResult(body, privateKey);

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("passes through when no signature_base64 and signature_valid is not false", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: { summary: "unsigned ok" },
      schema_valid: true
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("returns UNVERIFIED when signature_valid is explicitly false and no signature", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "ok",
      output: {},
      signature_valid: false
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("UNVERIFIED");
    expect(result.code).toBe("RESULT_SIGNATURE_INVALID");
  });

  it("defaults error code to EXEC_UNKNOWN when error.code is missing", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_test",
      result_version: "0.1.0",
      seller_id: "seller_1",
      subagent_id: "agent.v1",
      status: "error",
      error: { message: "something failed" },
      schema_valid: true
    };

    const result = applyResultPackage(request, body);
    expect(result.status).toBe("FAILED");
    expect(result.code).toBe("EXEC_UNKNOWN");
  });

  it("stores result_package on request regardless of outcome", () => {
    const request = makeRequest({ status: "ACKED" });
    const body = {
      request_id: "req_wrong",
      status: "ok",
      output: {}
    };

    applyResultPackage(request, body);
    expect(request.result_package).toBe(body);
  });
});

// --- createRequestRecord ---

describe("createRequestRecord", () => {
  it("generates request_id when not provided", () => {
    const config = loadBuyerConfig();
    const record = createRequestRecord(config, {});
    expect(record.request_id).toMatch(/^req_/);
    expect(record.status).toBe("CREATED");
  });

  it("uses provided request_id", () => {
    const config = loadBuyerConfig();
    const record = createRequestRecord(config, { request_id: "req_custom" });
    expect(record.request_id).toBe("req_custom");
  });

  it("applies timeout parameters from body", () => {
    const config = loadBuyerConfig();
    const record = createRequestRecord(config, {
      soft_timeout_s: 10,
      hard_timeout_s: 60
    });
    expect(record.soft_timeout_s).toBe(10);
    expect(record.hard_timeout_s).toBe(60);
  });

  it("falls back to config for ack_deadline_s", () => {
    const config = { ...loadBuyerConfig(), ack_deadline_s: 200 };
    const record = createRequestRecord(config, {});
    expect(record.ack_deadline_s).toBe(200);
  });

  it("initializes timeline with CREATED event", () => {
    const config = loadBuyerConfig();
    const record = createRequestRecord(config, {});
    expect(record.timeline).toHaveLength(1);
    expect(record.timeline[0].event).toBe("CREATED");
  });
});
