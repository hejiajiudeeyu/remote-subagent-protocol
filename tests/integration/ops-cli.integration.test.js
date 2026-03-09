import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createPlatformServer, createPlatformState } from "@croc/platform-api";
import { closeServer, listenServer } from "../helpers/http.js";

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
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "croc-ops-home-"));
    cleanupDirs.push(opsHome);

    const env = {
      ...process.env,
      CROC_OPS_HOME: opsHome
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
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "croc-ops-register-"));
    cleanupDirs.push(opsHome);
    const platformState = createPlatformState();
    const platformServer = createPlatformServer({ serviceName: "ops-cli-platform", state: platformState });
    const platformUrl = await listenServer(platformServer);

    try {
      const env = {
        ...process.env,
        CROC_OPS_HOME: opsHome
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
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "croc-ops-toggle-"));
    cleanupDirs.push(opsHome);

    const env = {
      ...process.env,
      CROC_OPS_HOME: opsHome
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
    const opsHome = fs.mkdtempSync(path.join(os.tmpdir(), "croc-ops-remove-"));
    cleanupDirs.push(opsHome);

    const env = {
      ...process.env,
      CROC_OPS_HOME: opsHome
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
});
