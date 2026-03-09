import { describe, expect, it } from "vitest";

import { ERROR_DOMAIN, REQUEST_STATUS } from "@croc/contracts";

describe("error codes and retryable markers", () => {
  const KNOWN_ERROR_CODES = {
    AUTH: [
      "AUTH_UNAUTHORIZED",
      "AUTH_TOKEN_INVALID",
      "AUTH_TOKEN_EXPIRED",
      "AUTH_RESOURCE_FORBIDDEN"
    ],
    CONTRACT: [
      "CONTRACT_REJECTED",
      "CONTRACT_TIMEOUT_EXCEEDS_SELLER_LIMIT"
    ],
    EXEC: [
      "EXEC_TIMEOUT_HARD",
      "EXEC_TIMEOUT_MANUAL_STOP",
      "EXEC_INTERNAL_ERROR",
      "EXEC_UNKNOWN"
    ],
    RESULT: [
      "RESULT_CONTEXT_MISMATCH",
      "RESULT_SIGNATURE_INVALID",
      "RESULT_SCHEMA_INVALID"
    ],
    DELIVERY: [
      "DELIVERY_OR_ACCEPTANCE_TIMEOUT"
    ]
  };

  const NON_RETRYABLE_CODES = new Set([
    "AUTH_TOKEN_EXPIRED",
    "AUTH_RESOURCE_FORBIDDEN",
    "CONTRACT_REJECTED",
    "RESULT_CONTEXT_MISMATCH",
    "RESULT_SIGNATURE_INVALID",
    "RESULT_SCHEMA_INVALID",
    "EXEC_TIMEOUT_MANUAL_STOP"
  ]);

  const RETRYABLE_CODES = new Set([
    "DELIVERY_OR_ACCEPTANCE_TIMEOUT",
    "EXEC_INTERNAL_ERROR",
    "AUTH_TOKEN_INVALID"
  ]);

  it("every known error code has a valid domain prefix", () => {
    const domains = new Set(Object.values(ERROR_DOMAIN));

    for (const [domain, codes] of Object.entries(KNOWN_ERROR_CODES)) {
      expect(domains).toContain(domain);
      for (const code of codes) {
        expect(code).toMatch(new RegExp(`^${domain}_`));
      }
    }
  });

  it("non-retryable codes should not overlap with retryable codes", () => {
    const overlap = [...NON_RETRYABLE_CODES].filter((c) => RETRYABLE_CODES.has(c));
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
});
