import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_DOMAIN, ERROR_REGISTRY, isKnownErrorCode } from "@delexec/contracts";

const ROOT = process.cwd();
const SEARCH_ROOTS = ["apps", "packages"];
const DOMAIN_PREFIXES = Object.values(ERROR_DOMAIN).map((domain) => `${domain}_`);
const NON_ERROR_EVENT_CODES = new Set([
  "CONTRACT_DRAFTED",
  "DELIVERY_META_ISSUED",
  "TASK_TOKEN_ISSUED"
]);
const NON_ERROR_CONSTANT_CODES = new Set([
  "TRANSPORT_EMAILENGINE_ACCESS_TOKEN",
  "TRANSPORT_GMAIL_CLIENT_SECRET",
  "TRANSPORT_GMAIL_REFRESH_TOKEN"
]);

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectSourceErrorCodes() {
  const found = new Set();
  for (const root of SEARCH_ROOTS) {
    const absRoot = path.join(ROOT, root);
    for (const file of walk(absRoot)) {
      const text = fs.readFileSync(file, "utf8");
      const matches = text.match(/"[A-Z][A-Z0-9_]+"/g) || [];
      for (const quoted of matches) {
        const value = quoted.slice(1, -1);
        if (
          DOMAIN_PREFIXES.some((prefix) => value.startsWith(prefix)) &&
          !NON_ERROR_EVENT_CODES.has(value) &&
          !NON_ERROR_CONSTANT_CODES.has(value)
        ) {
          found.add(value);
        }
      }
    }
  }
  return [...found].sort();
}

describe("error registry coverage", () => {
  it("registers every domain-prefixed source error code", () => {
    const sourceCodes = collectSourceErrorCodes();
    const missing = sourceCodes.filter((code) => !isKnownErrorCode(code));
    expect(missing).toEqual([]);
  });

  it("does not carry obviously unused registry entries", () => {
    const sourceCodes = new Set(collectSourceErrorCodes());
    const allowedDocOnly = new Set([
      "AUTH_TOKEN_NOT_FOUND",
      "AUTH_AUDIENCE_MISMATCH",
      "CONTRACT_UNSUPPORTED_VERSION",
      "DELIVERY_DUPLICATE",
      "DELIVERY_FAILED",
      "DELIVERY_PARSE_FAILED",
      "DELIVERY_RATE_LIMITED",
      "EXEC_IN_PROGRESS",
      "EXEC_INTERNAL_ERROR",
      "EXEC_QUEUE_FULL",
      "EXEC_TIMEOUT",
      "OPS_SUPERVISOR_INTERNAL_ERROR",
      "PLATFORM_RATE_LIMITED"
    ]);
    const unused = Object.keys(ERROR_REGISTRY).filter((code) => !sourceCodes.has(code) && !allowedDocOnly.has(code));
    expect(unused).toEqual([]);
  });
});
