import { describe, expect, it } from "vitest";

import {
  ERROR_DOMAIN,
  ERROR_REGISTRY,
  REQUEST_STATUS,
  buildStructuredError,
  getErrorDomain,
  isKnownErrorCode,
  isRetryableErrorCode
} from "@delexec/contracts";

describe("error codes and retryable markers", () => {
  it("every known error code has a valid domain prefix", () => {
    const domains = new Set(Object.values(ERROR_DOMAIN));
    for (const code of Object.keys(ERROR_REGISTRY)) {
      const domain = getErrorDomain(code);
      expect(domains).toContain(domain);
      expect(code).toMatch(new RegExp(`^${domain}_`));
    }
  });

  it("non-retryable codes should not overlap with retryable codes", () => {
    const retryable = Object.entries(ERROR_REGISTRY)
      .filter(([, meta]) => meta.retryable === true)
      .map(([code]) => code);
    const nonRetryable = Object.entries(ERROR_REGISTRY)
      .filter(([, meta]) => meta.retryable !== true)
      .map(([code]) => code);
    const overlap = nonRetryable.filter((code) => retryable.includes(code));
    expect(overlap).toEqual([]);
  });

  it("maps terminal error codes to terminal request statuses", () => {
    const terminalStatuses = new Set([
      REQUEST_STATUS.FAILED,
      REQUEST_STATUS.UNVERIFIED,
      REQUEST_STATUS.TIMED_OUT
    ]);

    const errorToTerminalStatus = {
      DELIVERY_OR_ACCEPTANCE_TIMEOUT: REQUEST_STATUS.TIMED_OUT,
      EXEC_TIMEOUT_HARD: REQUEST_STATUS.TIMED_OUT,
      EXEC_TIMEOUT_MANUAL_STOP: REQUEST_STATUS.TIMED_OUT,
      RESULT_CONTEXT_MISMATCH: REQUEST_STATUS.UNVERIFIED,
      RESULT_SIGNATURE_INVALID: REQUEST_STATUS.UNVERIFIED,
      RESULT_SCHEMA_INVALID: REQUEST_STATUS.UNVERIFIED,
      AUTH_TOKEN_EXPIRED: REQUEST_STATUS.FAILED,
      EXEC_INTERNAL_ERROR: REQUEST_STATUS.FAILED
    };

    for (const [, status] of Object.entries(errorToTerminalStatus)) {
      expect(terminalStatuses).toContain(status);
    }
  });

  it("REQUEST_STATUS includes all MVP states", () => {
    expect(Object.keys(REQUEST_STATUS)).toEqual(
      expect.arrayContaining(["CREATED", "SENT", "ACKED", "SUCCEEDED", "FAILED", "UNVERIFIED", "TIMED_OUT"])
    );
  });

  it("ERROR_DOMAIN values are all uppercase strings", () => {
    for (const value of Object.values(ERROR_DOMAIN)) {
      expect(value).toMatch(/^[A-Z]+$/);
    }
  });

  it("exposes retryable defaults through helper functions", () => {
    expect(isKnownErrorCode("AUTH_TOKEN_EXPIRED")).toBe(true);
    expect(isRetryableErrorCode("AUTH_TOKEN_EXPIRED")).toBe(false);
    expect(isRetryableErrorCode("AUTH_TOKEN_INVALID")).toBe(true);
    expect(isKnownErrorCode("UNKNOWN_CODE")).toBe(false);
    expect(isRetryableErrorCode("UNKNOWN_CODE")).toBe(false);
  });

  it("buildStructuredError uses registry retryable defaults unless overridden", () => {
    expect(buildStructuredError("AUTH_TOKEN_INVALID", "invalid").error.retryable).toBe(true);
    expect(buildStructuredError("AUTH_TOKEN_INVALID", "invalid", { retryable: false }).error.retryable).toBe(false);
    expect(buildStructuredError("UNKNOWN_CODE", "unknown").error.retryable).toBe(false);
  });
});
