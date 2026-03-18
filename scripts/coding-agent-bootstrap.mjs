#!/usr/bin/env node
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();
const CLI_PATH = path.resolve(ROOT_DIR, "apps/ops/src/cli.js");

async function main() {
  const args = process.argv.slice(2);
  try {
    const result = await execFileAsync(process.execPath, [CLI_PATH, "bootstrap", ...args], {
      env: process.env
    });
    process.stdout.write(result.stdout);
  } catch (error) {
    if (typeof error?.stdout === "string" && error.stdout.trim()) {
      process.stdout.write(error.stdout);
      process.exit(0);
    }
    const message = error instanceof Error ? error.message : "unknown_error";
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          stage: "bootstrap_wrapper_failed",
          error: message
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

await main();
