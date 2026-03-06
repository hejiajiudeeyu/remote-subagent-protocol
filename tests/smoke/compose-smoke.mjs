import { spawnSync } from "node:child_process";

function runCmd(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: options.stdio || "pipe",
    encoding: "utf8",
    cwd: options.cwd || process.cwd()
  });
  return result;
}

function canUseDocker() {
  const docker = runCmd("docker", ["info"]);
  return docker.status === 0;
}

function strictModeEnabled() {
  return String(process.env.STRICT_COMPOSE_SMOKE || "false").toLowerCase() === "true";
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

async function runScenario() {
  const platform = "http://127.0.0.1:8080";
  const buyer = "http://127.0.0.1:8081";
  const seller = "http://127.0.0.1:8082";
  const requestId = `req_compose_${Date.now()}`;

  const register = await jsonRequest(platform, "/v1/users/register", {
    method: "POST",
    body: { email: "compose-smoke@test.local" }
  });
  if (register.status !== 201) {
    throw new Error(`register_failed: ${register.status}`);
  }

  const auth = { Authorization: `Bearer ${register.body.api_key}` };

  const catalog = await jsonRequest(platform, "/v1/catalog/subagents?status=active");
  if (catalog.status !== 200 || !catalog.body?.items?.length) {
    throw new Error(`catalog_failed: ${catalog.status}`);
  }
  const selected = catalog.body.items[0];

  const token = await jsonRequest(platform, "/v1/tokens/task", {
    method: "POST",
    headers: auth,
    body: {
      request_id: requestId,
      seller_id: selected.seller_id,
      subagent_id: selected.subagent_id
    }
  });
  if (token.status !== 201) {
    throw new Error(`token_issue_failed: ${token.status}`);
  }

  const requestCreated = await jsonRequest(buyer, "/controller/requests", {
    method: "POST",
    body: {
      request_id: requestId,
      seller_id: selected.seller_id,
      subagent_id: selected.subagent_id,
      soft_timeout_s: 5,
      hard_timeout_s: 20
    }
  });
  if (requestCreated.status !== 201) {
    throw new Error(`buyer_request_create_failed: ${requestCreated.status}`);
  }

  await jsonRequest(buyer, `/controller/requests/${requestId}/mark-sent`, { method: "POST" });
  await jsonRequest(buyer, `/controller/requests/${requestId}/ack`, { method: "POST" });

  const task = await jsonRequest(seller, "/controller/tasks", {
    method: "POST",
    body: {
      request_id: requestId,
      subagent_id: selected.subagent_id,
      simulate: "success",
      delay_ms: 80
    }
  });
  if (task.status !== 202) {
    throw new Error(`seller_task_enqueue_failed: ${task.status}`);
  }

  const started = Date.now();
  for (;;) {
    const result = await jsonRequest(seller, `/controller/tasks/${task.body.task_id}/result`);
    if (result.status === 200 && result.body?.available === true) {
      const accepted = await jsonRequest(buyer, `/controller/requests/${requestId}/result`, {
        method: "POST",
        body: result.body.result_package
      });
      if (accepted.status !== 200) {
        throw new Error(`buyer_result_accept_failed: ${accepted.status}`);
      }
      break;
    }

    if (Date.now() - started > 30000) {
      throw new Error("seller_result_timeout");
    }

    await sleep(200);
  }

  const final = await jsonRequest(buyer, `/controller/requests/${requestId}`);
  if (final.status !== 200 || final.body?.status !== "SUCCEEDED") {
    throw new Error(`unexpected_final_status: ${final.status} ${final.body?.status || "n/a"}`);
  }

  console.log(`[compose-smoke] success request_id=${requestId} final_status=${final.body.status}`);
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

  const compose = ["compose", "-f", "docker-compose.yml"];

  try {
    console.log("[compose-smoke] up --build");
    const up = runCmd("docker", [...compose, "up", "-d", "--build"], { stdio: "inherit" });
    if (up.status !== 0) {
      throw new Error(`compose_up_failed: ${up.status}`);
    }

    console.log("[compose-smoke] waiting health checks");
    await waitHealth("http://127.0.0.1:8080/healthz");
    await waitHealth("http://127.0.0.1:8081/healthz");
    await waitHealth("http://127.0.0.1:8082/healthz");

    runPostgresCrudCheck(compose);
    await runScenario();
    console.log("[compose-smoke] completed");
  } finally {
    console.log("[compose-smoke] down");
    runCmd("docker", [...compose, "down"], { stdio: "inherit" });
  }
}

main().catch((error) => {
  console.error(`[compose-smoke] failed: ${error instanceof Error ? error.message : "unknown_error"}`);
  process.exit(1);
});
