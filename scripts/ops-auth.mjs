import path from "node:path";
import { fileURLToPath } from "node:url";

import { getOpsEnvFile, updateEnvFile } from "./env-files.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");

function usage() {
  console.log(`Usage:
  node scripts/ops-auth.mjs register --email <email> [--platform <url>] [--output <path>]

Examples:
  npm run ops:auth -- register --email you@example.com
  npm run ops:auth -- register --email you@example.com --platform http://127.0.0.1:8080 --output ~/.delexec/.env.local`);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = value;
        index += 1;
      }
      continue;
    }
    args._.push(token);
  }
  return args;
}

async function requestJson(baseUrl, pathname, { method = "GET", body } = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json; charset=utf-8" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function registerBuyer({ email, platformUrl, envFile }) {
  const response = await requestJson(platformUrl, "/v1/users/register", {
    method: "POST",
    body: {
      contact_email: email
    }
  });

  if (response.status !== 201 || !response.body?.api_key) {
    throw new Error(`buyer_registration_failed:${response.status}:${response.body?.error?.code || response.body?.error || "unknown_error"}`);
  }

  const written = updateEnvFile(envFile, {
    PLATFORM_API_BASE_URL: platformUrl,
    BUYER_PLATFORM_API_KEY: response.body.api_key,
    PLATFORM_API_KEY: response.body.api_key,
    BUYER_CONTACT_EMAIL: response.body.contact_email || email
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        user_id: response.body.user_id,
        contact_email: response.body.contact_email || email,
        env_file: envFile,
        persisted_keys: Object.keys(written).filter((key) =>
          ["PLATFORM_API_BASE_URL", "BUYER_PLATFORM_API_KEY", "PLATFORM_API_KEY", "BUYER_CONTACT_EMAIL"].includes(key)
        )
      },
      null,
      2
    )
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || args.help || args.h) {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (command !== "register") {
    usage();
    throw new Error(`unsupported_command:${command}`);
  }

  const email = String(args.email || "").trim();
  if (!email) {
    throw new Error("email_required");
  }

  const platformUrl = String(args.platform || "http://127.0.0.1:8080").trim();
  const envFile = path.resolve(args.output || args["env-file"] || getOpsEnvFile());
  await registerBuyer({ email, platformUrl, envFile });
}

main().catch((error) => {
  console.error(`[ops-auth] ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
