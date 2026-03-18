import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@delexec/platform-api";
import { createOpsSupervisorServer } from "../../apps/ops/src/supervisor.js";
import { closeServer, jsonRequest, listenServer } from "../helpers/http.js";

const execFileAsync = promisify(execFile);

const CLI_PATH = path.resolve(process.cwd(), "apps/ops/src/cli.js");

describe("ops cli integration", () => {
  const cleanupDirs = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initializes ops config idempotently and adds process/http subagents", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-home-"));
    cleanupDirs.push(opsHome);

    const env = {
      ...process.env,
      DELEXEC_HOME: opsHome
    };

    await execFileAsync(process.execPath, [CLI_PATH, "seller", "init", "--seller-id", "seller_cli_test"], { env });
    await execFileAsync(process.execPath, [CLI_PATH, "seller", "init", "--seller-id", "seller_cli_test"], { env });
    await execFileAsync(
      process.execPath,
      [
        CLI_PATH,
        "seller",
        "add-subagent",
        "--type",
        "process",
        "--subagent-id",
        "cli.process.v1",
        "--cmd",
        "node worker.js",
        "--task-type",
        "summarize",
        "--capability",
        "text.summarize"
      ],
      { env }
    );
    await execFileAsync(
      process.execPath,
      [
        CLI_PATH,
        "seller",
        "add-subagent",
        "--type",
        "http",
        "--subagent-id",
        "cli.http.v1",
        "--url",
        "http://127.0.0.1:9191/invoke",
        "--capability",
        "text.classify"
      ],
      { env }
    );

    const envText = fs.readFileSync(path.join(opsHome, ".env.local"), "utf8");
    const config = JSON.parse(fs.readFileSync(path.join(opsHome, "ops.config.json"), "utf8"));

    expect(envText).toContain("SELLER_ID=seller_cli_test");
    expect(envText).toContain("SUBAGENT_IDS=cli.process.v1,cli.http.v1");
    expect(config.seller.subagents).toHaveLength(2);
    expect(config.seller.subagents[0].adapter_type).toBe("process");
    expect(config.seller.subagents[1].adapter_type).toBe("http");
  });

  it("submits pending subagents explicitly and persists seller api key", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-register-"));
    cleanupDirs.push(opsHome);
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "ops-cli-platform", state: platformState });
    const platformUrl = await listenServer(platformServer);

    try {
      const env = {
        ...process.env,
        DELEXEC_HOME: opsHome
      };

      const auth = JSON.parse(
        (
          await execFileAsync(
            process.execPath,
            [CLI_PATH, "auth", "register", "--email", "ops-cli@test.local", "--platform", platformUrl],
            { env }
          )
        ).stdout
      );
      expect(auth.ok).toBe(true);

      await execFileAsync(process.execPath, [CLI_PATH, "seller", "init", "--seller-id", "seller_cli_register"], { env });
      await execFileAsync(
        process.execPath,
        [
          CLI_PATH,
          "seller",
          "add-subagent",
          "--type",
          "process",
          "--subagent-id",
          "cli.register.v1",
          "--cmd",
          "node worker.js"
        ],
        { env }
      );

      const enabled = JSON.parse((await execFileAsync(process.execPath, [CLI_PATH, "enable-seller"], { env })).stdout);
      expect(enabled.ok).toBe(true);
      expect(enabled.submitted).toBe(0);

      const output = JSON.parse((await execFileAsync(process.execPath, [CLI_PATH, "submit-review"], { env })).stdout);
      expect(output.ok).toBe(true);
      expect(output.submitted).toBe(1);

      const envText = fs.readFileSync(path.join(opsHome, ".env.local"), "utf8");
      const config = JSON.parse(fs.readFileSync(path.join(opsHome, "ops.config.json"), "utf8"));
      expect(envText).toContain("SELLER_PLATFORM_API_KEY=sk_seller_");
      expect(config.seller.subagents[0].submitted_for_review).toBe(true);
      expect(config.seller.subagents[0].review_status).toBe("pending");
    } finally {
      await closeServer(platformServer);
    }
  });

  it("toggles local subagent enabled state through the cli", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-toggle-"));
    cleanupDirs.push(opsHome);

    const env = {
      ...process.env,
      DELEXEC_HOME: opsHome
    };

    await execFileAsync(process.execPath, [CLI_PATH, "setup", "--seller-id", "seller_cli_toggle"], { env });
    await execFileAsync(
      process.execPath,
      [CLI_PATH, "add-subagent", "--type", "process", "--subagent-id", "cli.toggle.v1", "--cmd", "node worker.js"],
      { env }
    );
    await execFileAsync(process.execPath, [CLI_PATH, "disable-subagent", "--subagent-id", "cli.toggle.v1"], { env });

    let config = JSON.parse(fs.readFileSync(path.join(opsHome, "ops.config.json"), "utf8"));
    expect(config.seller.subagents[0].enabled).toBe(false);

    await execFileAsync(process.execPath, [CLI_PATH, "enable-subagent", "--subagent-id", "cli.toggle.v1"], { env });
    config = JSON.parse(fs.readFileSync(path.join(opsHome, "ops.config.json"), "utf8"));
    expect(config.seller.subagents[0].enabled).toBe(true);
  });

  it("removes a local subagent through the cli", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-remove-"));
    cleanupDirs.push(opsHome);

    const env = {
      ...process.env,
      DELEXEC_HOME: opsHome
    };

    await execFileAsync(process.execPath, [CLI_PATH, "setup", "--seller-id", "seller_cli_remove"], { env });
    await execFileAsync(
      process.execPath,
      [CLI_PATH, "add-subagent", "--type", "process", "--subagent-id", "cli.remove.v1", "--cmd", "node worker.js"],
      { env }
    );
    await execFileAsync(process.execPath, [CLI_PATH, "remove-subagent", "--subagent-id", "cli.remove.v1"], { env });

    const config = JSON.parse(fs.readFileSync(path.join(opsHome, "ops.config.json"), "utf8"));
    expect(config.seller.subagents.some((item) => item.subagent_id === "cli.remove.v1")).toBe(false);
  });

  it("installs the official example subagent through the cli", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-example-"));
    cleanupDirs.push(opsHome);

    const env = {
      ...process.env,
      DELEXEC_HOME: opsHome
    };

    const output = JSON.parse((await execFileAsync(process.execPath, [CLI_PATH, "add-example-subagent"], { env })).stdout);
    const config = JSON.parse(fs.readFileSync(path.join(opsHome, "ops.config.json"), "utf8"));
    const example = config.seller.subagents.find((item) => item.subagent_id === "local.summary.v1");

    expect(output.ok).toBe(true);
    expect(example).toBeTruthy();
    expect(example.display_name).toBe("Local Summary Example");
    expect(example.task_types).toEqual(["text_summarize"]);
    expect(example.capabilities).toEqual(["text.summarize"]);
    expect(example.tags).toEqual(["local", "example", "demo"]);
    expect(example.adapter_type).toBe("process");
    expect(example.adapter.cmd).toContain("example-subagent-worker.js");
  });

  it("bootstraps the local client and stops at admin approval when operator credentials are unavailable", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-bootstrap-awaiting-"));
    cleanupDirs.push(opsHome);

    const supervisorPort = String(56000 + Math.floor(Math.random() * 500));
    const relayPort = String(56500 + Math.floor(Math.random() * 500));
    const buyerPort = String(57000 + Math.floor(Math.random() * 500));
    const sellerPort = String(57500 + Math.floor(Math.random() * 500));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "ops-cli-bootstrap-awaiting", state: platformState });
    const platformUrl = await listenServer(platformServer);

    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;
    process.env.OPS_PORT_SUPERVISOR = supervisorPort;
    process.env.OPS_PORT_RELAY = relayPort;
    process.env.OPS_PORT_BUYER = buyerPort;
    process.env.OPS_PORT_SELLER = sellerPort;

    const supervisor = createOpsSupervisorServer();
    await new Promise((resolve) => supervisor.listen(Number(supervisorPort), "127.0.0.1", resolve));
    await jsonRequest(`http://127.0.0.1:${supervisorPort}`, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      const env = {
        ...process.env,
        DELEXEC_HOME: opsHome,
        PLATFORM_API_BASE_URL: platformUrl,
        OPS_PORT_SUPERVISOR: supervisorPort,
        OPS_PORT_RELAY: relayPort,
        OPS_PORT_BUYER: buyerPort,
        OPS_PORT_SELLER: sellerPort
      };

      const output = JSON.parse(
        (await execFileAsync(process.execPath, [CLI_PATH, "bootstrap", "--email", "bootstrap-awaiting@test.local"], { env })).stdout
      );

      expect(output.ok).toBe(false);
      expect(output.stage).toBe("awaiting_admin_approval");
      expect(output.subagent_id).toBe("local.summary.v1");
      expect(output.steps.map((item) => item.step)).toContain("review_submitted");
      expect(output.steps.map((item) => item.step)).toContain("seller_enabled");
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

  it("bootstraps the local client end-to-end when operator approval is available", async () => {
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-bootstrap-success-"));
    cleanupDirs.push(opsHome);

    const supervisorPort = String(58000 + Math.floor(Math.random() * 500));
    const relayPort = String(58500 + Math.floor(Math.random() * 500));
    const buyerPort = String(59000 + Math.floor(Math.random() * 500));
    const sellerPort = String(59500 + Math.floor(Math.random() * 500));

    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "ops-cli-bootstrap-success", state: platformState });
    const platformUrl = await listenServer(platformServer);

    process.env.DELEXEC_HOME = opsHome;
    process.env.PLATFORM_API_BASE_URL = platformUrl;
    process.env.PLATFORM_ADMIN_API_KEY = platformState.adminApiKey;
    process.env.OPS_PORT_SUPERVISOR = supervisorPort;
    process.env.OPS_PORT_RELAY = relayPort;
    process.env.OPS_PORT_BUYER = buyerPort;
    process.env.OPS_PORT_SELLER = sellerPort;

    const supervisor = createOpsSupervisorServer();
    await new Promise((resolve) => supervisor.listen(Number(supervisorPort), "127.0.0.1", resolve));
    await jsonRequest(`http://127.0.0.1:${supervisorPort}`, "/setup", { method: "POST", body: {} });
    await supervisor.startManagedServices();

    try {
      const env = {
        ...process.env,
        DELEXEC_HOME: opsHome,
        PLATFORM_API_BASE_URL: platformUrl,
        PLATFORM_ADMIN_API_KEY: platformState.adminApiKey,
        OPS_PORT_SUPERVISOR: supervisorPort,
        OPS_PORT_RELAY: relayPort,
        OPS_PORT_BUYER: buyerPort,
        OPS_PORT_SELLER: sellerPort
      };

      const output = JSON.parse(
        (
          await execFileAsync(
            process.execPath,
            [CLI_PATH, "bootstrap", "--email", "bootstrap-success@test.local", "--text", "Summarize this bootstrap request."],
            { env }
          )
        ).stdout
      );

      expect(output.ok).toBe(true);
      expect(output.status).toBe("SUCCEEDED");
      expect(output.subagent_id).toBe("local.summary.v1");
      expect(output.steps.find((item) => item.step === "request_succeeded")?.ok).toBe(true);
    } finally {
      await supervisor.stopManagedServices();
      await closeServer(supervisor);
      await closeServer(platformServer);
      delete process.env.DELEXEC_HOME;
      delete process.env.PLATFORM_API_BASE_URL;
      delete process.env.PLATFORM_ADMIN_API_KEY;
      delete process.env.OPS_PORT_SUPERVISOR;
      delete process.env.OPS_PORT_RELAY;
      delete process.env.OPS_PORT_BUYER;
      delete process.env.OPS_PORT_SELLER;
    }
  });
  it("packs into a clean-room installable cli tarball", async () => {
    const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-pack-"));
    const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-ops-clean-room-"));
    cleanupDirs.push(packDir);
    cleanupDirs.push(installDir);

    const packed = await execFileAsync("npm", ["pack", "--workspace", "@delexec/ops"], {
      cwd: process.cwd(),
      env: process.env
    });
    const tarballName = packed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    const tarballPath = path.join(process.cwd(), tarballName);
    const copiedTarballPath = path.join(packDir, tarballName);
    fs.copyFileSync(tarballPath, copiedTarballPath);
    fs.rmSync(tarballPath, { force: true });

    await execFileAsync("npm", ["init", "-y"], {
      cwd: installDir,
      env: process.env
    });
    await execFileAsync("npm", ["install", copiedTarballPath], {
      cwd: installDir,
      env: process.env
    });

    const doctor = await execFileAsync(path.join(installDir, "node_modules/.bin/delexec-ops"), ["doctor"], {
      cwd: installDir,
      env: {
        ...process.env,
        DELEXEC_HOME: path.join(installDir, ".ops-home")
      }
    });
    const output = JSON.parse(doctor.stdout);
    expect(output.config.platform.base_url).toBe("http://127.0.0.1:8080");
    expect(output.config.seller.seller_id).toBe("seller_cli_test");
  });
});
