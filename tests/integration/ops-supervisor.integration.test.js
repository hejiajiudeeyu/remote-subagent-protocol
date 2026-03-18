import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createOpsSupervisorServer } from "../../apps/ops/src/supervisor.js";
import { closeServer, jsonRequest, listenServer, waitFor } from "../helpers/http.js";

describe("ops supervisor integration", () => {
  const cleanupDirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts relay and buyer, then proxies buyer registration and request listing", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-home-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(18000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(19000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(20000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(21000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-supervisor-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      await waitFor(async () => {
        const status = await jsonRequest(supervisorUrl, "/status");
        if (!status.body?.runtime?.buyer?.running || !status.body?.runtime?.relay?.running) {
          throw new Error("runtime_not_ready");
        }
        if (status.body.runtime.buyer.health?.status !== 200 || status.body.runtime.relay.health?.status !== 200) {
          throw new Error("health_not_ready");
        }
        return status;
      });

      const registered = await jsonRequest(supervisorUrl, "/auth/register-buyer", {
        method: "POST",
        body: { contact_email: "ops-supervisor@test.local" }
      });
      expect(registered.status).toBe(201);

      const requests = await waitFor(async () => {
        const current = await jsonRequest(supervisorUrl, "/requests");
        if (current.status !== 200) {
          throw new Error("requests_not_ready");
        }
        return current;
      });
      expect(Array.isArray(requests.body.items)).toBe(true);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("starts relay from an external command instead of a direct package entry", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-external-relay-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(36000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(37000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(38000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(39000 + Math.floor(Math.random() * 1000));

    const relayScript = path.join(opsHome, "external-relay.mjs");
    fs.writeFileSync(
      relayScript,
      `import http from "node:http";
const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => {
  if ((req.method || "GET") === "GET" && (req.url || "/") === "/healthz") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: process.env.SERVICE_NAME || "external-relay" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true }));
});
server.listen(port, "127.0.0.1");
`,
      "utf8"
    );

    process.env.OPS_RELAY_BIN = process.execPath;
    process.env.OPS_RELAY_ARGS = JSON.stringify([relayScript]);
    process.env.DELEXEC_HOME = opsHome;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      const status = await waitFor(async () => {
        const current = await jsonRequest(supervisorUrl, "/status");
        if (current.body?.runtime?.relay?.health?.status !== 200) {
          throw new Error("relay_not_ready");
        }
        return current;
      });

      expect(status.body.runtime.relay.managed).toBe(true);
      expect(status.body.runtime.relay.launch_mode).toBe("configured_command");
      expect(status.body.runtime.relay.health.status).toBe(200);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      delete process.env.DELEXEC_HOME;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
      delete process.env.OPS_RELAY_BIN;
      delete process.env.OPS_RELAY_ARGS;
    }
  });

  it("separates seller enable from review submission", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-review-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(22000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(23000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(24000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(25000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-review-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      const registered = await jsonRequest(supervisorUrl, "/auth/register-buyer", {
        method: "POST",
        body: { contact_email: "ops-review@test.local" }
      });
      expect(registered.status).toBe(201);

      const added = await jsonRequest(supervisorUrl, "/seller/subagents", {
        method: "POST",
        body: {
          subagent_id: "ops.review.v1",
          display_name: "Ops Review",
          task_types: ["text_classify"],
          capabilities: ["text.classify"],
          adapter_type: "process",
          adapter: { cmd: "node worker.js" }
        }
      });
      expect(added.status).toBe(201);

      const enabled = await jsonRequest(supervisorUrl, "/seller/enable", {
        method: "POST",
        body: { seller_id: "seller_ops_review" }
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body.submitted).toBe(0);

      const statusBeforeReview = await jsonRequest(supervisorUrl, "/status");
      expect(statusBeforeReview.body.seller.pending_review_count).toBe(1);

      const submitted = await jsonRequest(supervisorUrl, "/seller/submit-review", {
        method: "POST",
        body: {}
      });
      expect(submitted.status).toBe(201);
      expect(submitted.body.submitted).toBe(1);

      const statusAfterReview = await jsonRequest(supervisorUrl, "/status");
      expect(statusAfterReview.body.seller.pending_review_count).toBe(0);
      expect(statusAfterReview.body.seller.review_summary.pending).toBe(1);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("toggles a local subagent on the seller side", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-toggle-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(32000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(33000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(34000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(35000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-toggle-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      const added = await jsonRequest(supervisorUrl, "/seller/subagents", {
        method: "POST",
        body: {
          subagent_id: "ops.toggle.v1",
          adapter_type: "process",
          adapter: { cmd: "node worker.js" }
        }
      });
      expect(added.status).toBe(201);

      const disabled = await jsonRequest(supervisorUrl, "/seller/subagents/ops.toggle.v1/disable", {
        method: "POST",
        body: {}
      });
      expect(disabled.status).toBe(200);
      expect(disabled.body.enabled).toBe(false);

      const enabled = await jsonRequest(supervisorUrl, "/seller/subagents/ops.toggle.v1/enable", {
        method: "POST",
        body: {}
      });
      expect(enabled.status).toBe(200);
      expect(enabled.body.enabled).toBe(true);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("requires a local session for protected routes once the encrypted secret store is initialized", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-session-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(26000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(27000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(28000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(29000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-session-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;

    try {
      const setupSession = await jsonRequest(supervisorUrl, "/auth/session/setup", {
        method: "POST",
        body: { passphrase: "local-passphrase" }
      });
      expect(setupSession.status).toBe(201);
      expect(setupSession.body.session.authenticated).toBe(true);

      const denied = await jsonRequest(supervisorUrl, "/runtime/transport");
      expect(denied.status).toBe(401);

      const sessionHeaders = {
        "X-Ops-Session": setupSession.body.token
      };
      const allowed = await jsonRequest(supervisorUrl, "/runtime/transport", {
        headers: sessionHeaders
      });
      expect(allowed.status).toBe(200);
      expect(allowed.body.type).toBe("local");

      const logout = await jsonRequest(supervisorUrl, "/auth/session/logout", {
        method: "POST",
        headers: sessionHeaders,
        body: {}
      });
      expect(logout.status).toBe(200);
      expect(logout.body.session.authenticated).toBe(false);

      const deniedAgain = await jsonRequest(supervisorUrl, "/runtime/transport");
      expect(deniedAgain.status).toBe(401);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("removes a local subagent from seller config", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-remove-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(36000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(37000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(38000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(39000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-remove-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      await jsonRequest(supervisorUrl, "/seller/subagents", {
        method: "POST",
        body: {
          subagent_id: "ops.remove.v1",
          adapter_type: "process",
          adapter: { cmd: "node worker.js" }
        }
      });

      const removed = await jsonRequest(supervisorUrl, "/seller/subagents/ops.remove.v1", {
        method: "DELETE"
      });
      expect(removed.status).toBe(200);
      expect(removed.body.removed.subagent_id).toBe("ops.remove.v1");

      const list = await jsonRequest(supervisorUrl, "/seller/subagents");
      expect(list.body.items.some((item) => item.subagent_id === "ops.remove.v1")).toBe(false);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("writes service logs and exposes a debug snapshot", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-debug-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(40000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(41000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(42000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(43000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-debug-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      const snapshot = await waitFor(async () => {
        const current = await jsonRequest(supervisorUrl, "/debug/snapshot");
        if (!Array.isArray(current.body?.log_tail?.buyer) || current.body.log_tail.buyer.length === 0) {
          throw new Error("buyer_log_not_ready");
        }
        return current;
      });
      expect(snapshot.status).toBe(200);
      expect(snapshot.body.status.debug.logs_dir).toContain(opsHome);
      expect(Array.isArray(snapshot.body.recent_events)).toBe(true);

      const runtimeLogs = await jsonRequest(supervisorUrl, "/runtime/logs?service=buyer");
      expect(runtimeLogs.status).toBe(200);
      expect(runtimeLogs.body.file).toContain(path.join("logs", "buyer.log"));
      expect(runtimeLogs.body.logs.length).toBeGreaterThan(0);

      const runtimeAlerts = await jsonRequest(supervisorUrl, "/runtime/alerts?service=buyer");
      expect(runtimeAlerts.status).toBe(200);
      expect(Array.isArray(runtimeAlerts.body.alerts)).toBe(true);

      expect(fs.existsSync(path.join(opsHome, "logs", "buyer.log"))).toBe(true);
      expect(fs.existsSync(path.join(opsHome, "logs", "supervisor.events.jsonl"))).toBe(true);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("stores transport config with redacted secrets and tests emailengine connection", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-transport-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(44000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(45000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(46000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(47000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-transport-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const emailEngineServer = await (async () => {
      const http = await import("node:http");
      const server = http.createServer((req, res) => {
        if (req.url === "/v1/account/buyer%40example.com" && req.headers.authorization === "Bearer ee-secret") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ account: "buyer@example.com" }));
          return;
        }
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
      });
      const url = await listenServer(server);
      return { server, url };
    })();

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });

    try {
      const initial = await jsonRequest(supervisorUrl, "/runtime/transport");
      expect(initial.status).toBe(200);
      expect(initial.body.type).toBe("local");

      const saved = await jsonRequest(supervisorUrl, "/runtime/transport", {
        method: "PUT",
        body: {
          type: "email",
          email: {
            provider: "emailengine",
            sender: "buyer@example.com",
            receiver: "seller@example.com",
            poll_interval_ms: 7000,
            emailengine: {
              base_url: emailEngineServer.url,
              account: "buyer@example.com",
              access_token: "ee-secret"
            }
          }
        }
      });
      expect(saved.status).toBe(200);
      expect(saved.body.type).toBe("email");
      expect(saved.body.email.provider).toBe("emailengine");
      expect(saved.body.email.emailengine.access_token_configured).toBe(true);
      expect(saved.body.email.emailengine.access_token).toBeUndefined();

      const tested = await jsonRequest(supervisorUrl, "/runtime/transport/test", {
        method: "POST",
        body: {}
      });
      expect(tested.status).toBe(200);
      expect(tested.body.ok).toBe(true);
      expect(tested.body.kind).toBe("emailengine");

      const envText = fs.readFileSync(path.join(opsHome, ".env.local"), "utf8");
      expect(envText).toContain("TRANSPORT_EMAILENGINE_ACCESS_TOKEN=ee-secret");
      expect(envText).toContain(`TRANSPORT_EMAILENGINE_BASE_URL=${emailEngineServer.url}`);
      expect(envText).toContain("TRANSPORT_TYPE=email");
    } finally {
      await closeServer(emailEngineServer.server);
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("tests gmail transport and keeps buyer runtime running with configured adapter", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-gmail-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(48000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(49000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(50000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(51000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-gmail-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input.url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ access_token: "gmail-access-token" });
          },
          async json() {
            return { access_token: "gmail-access-token" };
          }
        };
      }
      if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/buyer%40example.com/profile")) {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ emailAddress: "buyer@example.com" });
          },
          async json() {
            return { emailAddress: "buyer@example.com" };
          }
        };
      }
      return originalFetch(input, init);
    }));

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });

    try {
      const saved = await jsonRequest(supervisorUrl, "/runtime/transport", {
        method: "PUT",
        body: {
          type: "email",
          email: {
            provider: "gmail",
            sender: "buyer@example.com",
            receiver: "seller@example.com",
            poll_interval_ms: 5000,
            gmail: {
              client_id: "gmail-client-id",
              user: "buyer@example.com",
              client_secret: "gmail-client-secret",
              refresh_token: "gmail-refresh-token"
            }
          }
        }
      });
      expect(saved.status).toBe(200);
      expect(saved.body.email.gmail.client_secret_configured).toBe(true);
      expect(saved.body.email.gmail.refresh_token_configured).toBe(true);

      const tested = await jsonRequest(supervisorUrl, "/runtime/transport/test", {
        method: "POST",
        body: {}
      });
      expect(tested.status).toBe(200);
      expect(tested.body.ok).toBe(true);
      expect(tested.body.kind).toBe("gmail");

      await supervisor.startManagedServices();
      const status = await waitFor(async () => {
        const current = await jsonRequest(supervisorUrl, "/status");
        if (current.body?.runtime?.buyer?.running !== true) {
          throw new Error("buyer_not_running");
        }
        return current;
      });
      expect(status.body.runtime.buyer.running).toBe(true);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });

  it("installs the official example subagent and reports missing review stage for self-call", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "ops-supervisor-example-"));
    cleanupDirs.push(opsHome);
    process.env.OPS_PORT_SUPERVISOR = String(52000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_RELAY = String(53000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_BUYER = String(54000 + Math.floor(Math.random() * 1000));
    process.env.OPS_PORT_SELLER = String(55000 + Math.floor(Math.random() * 1000));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "platform-ops-example-test", state: platformState });
    const platformUrl = await listenServer(platformServer);
    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;

    const supervisor = createOpsSupervisorServer();
    supervisor.listen(0, "127.0.0.1");
    await new Promise((resolve) => supervisor.once("listening", resolve));
    const supervisorUrl = `http://127.0.0.1:${supervisor.address().port}`;
    await jsonRequest(supervisorUrl, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      await jsonRequest(supervisorUrl, "/auth/register-buyer", {
        method: "POST",
        body: { contact_email: "ops-example@test.local" }
      });

      const added = await jsonRequest(supervisorUrl, "/seller/subagents/example", {
        method: "POST",
        body: {}
      });
      expect(added.status).toBe(201);
      expect(added.body.subagent_id).toBe("local.summary.v1");

      const enabled = await jsonRequest(supervisorUrl, "/seller/enable", {
        method: "POST",
        body: { seller_id: "seller_ops_example" }
      });
      expect(enabled.status).toBe(200);

      const started = await jsonRequest(supervisorUrl, "/requests/example", {
        method: "POST",
        body: { text: "Summarize this local example request." }
      });
      expect(started.status).toBe(409);
      expect(started.body.error.code).toBe("EXAMPLE_REVIEW_NOT_SUBMITTED");
      expect(started.body.stage).toBe("submit_review");
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });
});
