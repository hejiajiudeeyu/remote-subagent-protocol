import { spawnSync } from "node:child_process";

function runCmd(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.stdio || "pipe",
    encoding: "utf8",
    cwd: options.cwd || process.cwd()
  });
  return result;
}

function summarizeOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function classifyComposeFailure(output) {
  const text = String(output || "").toLowerCase();
  if (
    text.includes("failed to resolve source metadata") ||
    text.includes("error pulling image") ||
    text.includes("pull access denied") ||
    text.includes("failed to authorize") ||
    text.includes("failed to fetch oauth token") ||
    text.includes("oauth token") ||
    text.includes("auth.docker.io/token") ||
    text.includes("tls handshake timeout") ||
    text.includes("i/o timeout") ||
    text.includes("context deadline exceeded") ||
    (text.includes("eof") && (text.includes("docker.io") || text.includes("authorize") || text.includes("token")))
  ) {
    return "image_pull_failed";
  }
  if (text.includes("port is already allocated") || text.includes("address already in use")) {
    return "port_conflict";
  }
  return "compose_up_failed";
}

function canUseDocker() {
  const docker = runCmd("docker", ["info"]);
  return docker.status === 0;
}

function strictModeEnabled() {
  return String(process.env.STRICT_COMPOSE_SMOKE || "false").toLowerCase() === "true";
}

function resolveComposeArgs() {
  const composeFile = process.env.COMPOSE_FILE || "docker-compose.yml";
  const args = ["compose", "-f", composeFile];
  if (process.env.COMPOSE_ENV_FILE) {
    args.push("--env-file", process.env.COMPOSE_ENV_FILE);
  }
  return args;
}

function useNoBuild() {
  return String(process.env.COMPOSE_NO_BUILD || "false").toLowerCase() === "true";
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealth(url, timeoutMs = 120000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // ignore and retry
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(`health_check_timeout: ${url}`);
    }
    await sleep(1000);
  }
}

async function jsonRequest(baseUrl, path, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  const requestInit = { method, headers };

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, requestInit);
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      if (Date.now() - started >= timeoutMs) {
        throw error;
      }
      await sleep(intervalMs);
    }
  }
}

async function runScenario() {
  const platform = "http://127.0.0.1:8080";
  const buyer = "http://127.0.0.1:8081";
  const requestId = `req_compose_${Date.now()}`;

  const register = await jsonRequest(buyer, "/controller/register", {
    method: "POST",
    body: { email: "compose-smoke@test.local" }
  });
  if (register.status !== 201) {
    throw new Error(`register_failed: ${register.status}`);
  }

  const auth = { "X-Platform-Api-Key": register.body.api_key };

  const catalog = await jsonRequest(buyer, "/controller/catalog/subagents?status=enabled", {
    headers: auth
  });
  if (catalog.status !== 200 || !catalog.body?.items?.length) {
    throw new Error(`catalog_failed: ${catalog.status}`);
  }
  const selected = catalog.body.items[0];

  const started = await jsonRequest(buyer, "/controller/remote-requests", {
    method: "POST",
    headers: auth,
    body: {
      request_id: requestId,
      seller_id: selected.seller_id,
      subagent_id: selected.subagent_id,
      expected_signer_public_key_pem: selected.seller_public_key_pem,
      soft_timeout_s: 5,
      hard_timeout_s: 20,
      simulate: "success",
      delay_ms: 80
    }
  });
  if (started.status !== 201) {
    throw new Error(`buyer_remote_request_failed: ${started.status}`);
  }

  const events = await waitFor(async () => {
    const polled = await jsonRequest(platform, `/v1/requests/${requestId}/events`, {
      headers: { Authorization: `Bearer ${register.body.api_key}` }
    });
    if (polled.status !== 200 || !polled.body?.events?.some((event) => event.event_type === "ACKED")) {
      throw new Error("ack_not_ready");
    }
    return polled;
  });

  const final = await waitFor(async () => {
    const current = await jsonRequest(buyer, `/controller/requests/${requestId}`);
    if (current.status !== 200 || current.body?.status !== "SUCCEEDED") {
      throw new Error("buyer_result_not_ready");
    }
    return current;
  });

  console.log(`[compose-smoke] success request_id=${requestId} acked=${events.body.events.some((event) => event.event_type === "ACKED")} final_status=${final.body.status}`);
}

function runPostgresCrudCheck(composeArgs) {
  const sql = [
    "CREATE TABLE IF NOT EXISTS smoke_checks (id SERIAL PRIMARY KEY, note TEXT NOT NULL);",
    "INSERT INTO smoke_checks (note) VALUES ('compose-smoke');",
    "SELECT COUNT(*) FROM smoke_checks;",
    "TRUNCATE TABLE smoke_checks;"
  ].join(" ");

  const result = runCmd(
    "docker",
    [...composeArgs, "exec", "-T", "postgres", "psql", "-U", "croc", "-d", "croc", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { stdio: "pipe" }
  );

  if (result.status !== 0) {
    throw new Error(`postgres_crud_check_failed: ${result.stderr || result.stdout || "unknown"}`);
  }
  console.log("[compose-smoke] postgres CRUD check passed");
}

async function main() {
  if (!canUseDocker()) {
    const message = "[compose-smoke] docker daemon not available";
    if (strictModeEnabled()) {
      console.error(`${message} (strict mode -> fail)`);
      process.exit(2);
    }
    console.log(`${message} (non-strict mode -> skip)`);
    process.exit(0);
  }

  const compose = resolveComposeArgs();

  try {
    console.log(`[compose-smoke] up ${useNoBuild() ? "--no-build" : "--build"}`);
    const up = runCmd("docker", [...compose, "up", "-d", ...(useNoBuild() ? ["--no-build"] : ["--build"])]);
    if (up.status !== 0) {
      const output = summarizeOutput(up);
      const classified = classifyComposeFailure(output);
      console.error(output);
      throw new Error(`${classified}: ${up.status}`);
    }

    console.log("[compose-smoke] waiting health checks");
    await waitHealth("http://127.0.0.1:8090/healthz");
    await waitHealth("http://127.0.0.1:8080/healthz");
    await waitHealth("http://127.0.0.1:8081/healthz");
    await waitHealth("http://127.0.0.1:8082/healthz");

    runPostgresCrudCheck(compose);
    await runScenario();
    console.log("[compose-smoke] completed");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    console.error(`[compose-smoke] diagnostics reason=${reason}`);
    const ps = runCmd("docker", [...compose, "ps"], { stdio: "pipe" });
    const logs = runCmd("docker", [...compose, "logs", "--no-color", "--tail", "200"], { stdio: "pipe" });
    if (ps.status === 0) {
      console.error(`[compose-smoke] compose ps\n${summarizeOutput(ps)}`);
    }
    if (logs.status === 0) {
      console.error(`[compose-smoke] compose logs\n${summarizeOutput(logs)}`);
    }
    throw error;
  } finally {
    console.log("[compose-smoke] down");
    const down = runCmd("docker", [...compose, "down"], { stdio: "pipe" });
    if (down.status !== 0) {
      console.error(`[compose-smoke] down_failed\n${summarizeOutput(down)}`);
    }
  }
}

main().catch((error) => {
  console.error(`[compose-smoke] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
