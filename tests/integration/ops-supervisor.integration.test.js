import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@croc/platform-api";
import { createOpsSupervisorServer } from "../../apps/ops/src/supervisor.js";
import { closeServer, jsonRequest, listenServer, waitFor } from "../helpers/http.js";

describe("ops supervisor integration", () => {
  const cleanupDirs = [];

  afterEach(() => {
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
    process.env.CROC_OPS_HOME = opsHome;
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
      delete process.env.CROC_OPS_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
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
    process.env.CROC_OPS_HOME = opsHome;
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
      delete process.env.CROC_OPS_HOME;
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
    process.env.CROC_OPS_HOME = opsHome;
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
      delete process.env.CROC_OPS_HOME;
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
    process.env.CROC_OPS_HOME = opsHome;
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
      delete process.env.CROC_OPS_HOME;
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
    process.env.CROC_OPS_HOME = opsHome;
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
      delete process.env.CROC_OPS_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });
});
