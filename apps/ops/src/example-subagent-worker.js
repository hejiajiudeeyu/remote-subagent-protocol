#!/usr/bin/env node

import process from "node:process";

import { summarizeExampleText } from "./example-subagent.js";

let raw = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});

process.stdin.on("end", () => {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    const text = payload?.input?.text ?? payload?.payload?.text ?? "";
    process.stdout.write(
      JSON.stringify({
        status: "ok",
        output: {
          summary: summarizeExampleText(text)
        },
        schema_valid: true,
        usage: {
          tokens_in: String(text || "").trim() ? 1 : 0,
          tokens_out: 1
        }
      })
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        status: "error",
        error: {
          code: "SUBAGENT_INVALID_INPUT",
          message: error instanceof Error ? error.message : "invalid_input",
          retryable: false
        },
        schema_valid: true,
        usage: {
          tokens_in: 0,
          tokens_out: 0
        }
      })
    );
  }
});
