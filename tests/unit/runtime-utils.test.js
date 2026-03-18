import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureOpsDirectories, getOpsHomeDir, migrateLegacyOpsHomeDir } from "@delexec/runtime-utils";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DELEXEC_HOME = process.env.DELEXEC_HOME;
const ORIGINAL_CROC_OPS_HOME = process.env.CROC_OPS_HOME;

describe("runtime-utils local state migration", () => {
  const cleanupDirs = [];

  afterEach(() => {
    process.env.HOME = ORIGINAL_HOME;
    if (ORIGINAL_DELEXEC_HOME === undefined) {
      delete process.env.DELEXEC_HOME;
    } else {
      process.env.DELEXEC_HOME = ORIGINAL_DELEXEC_HOME;
    }
    if (ORIGINAL_CROC_OPS_HOME === undefined) {
      delete process.env.CROC_OPS_HOME;
    } else {
      process.env.CROC_OPS_HOME = ORIGINAL_CROC_OPS_HOME;
    }
    while (cleanupDirs.length > 0) {
      fs.rmSync(cleanupDirs.pop(), { recursive: true, force: true });
    }
  });

  it("migrates the default legacy local state directory into ~/.delexec", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-home-"));
    cleanupDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    delete process.env.DELEXEC_HOME;
    delete process.env.CROC_OPS_HOME;

    const legacyHome = path.join(fakeHome, ".remote-subagent");
    fs.mkdirSync(path.join(legacyHome, "logs"), { recursive: true });
    fs.writeFileSync(path.join(legacyHome, "ops.config.json"), "{\"ok\":true}\n", "utf8");
    fs.writeFileSync(path.join(legacyHome, "croc.sqlite"), "legacy-sqlite", "utf8");

    const migrated = migrateLegacyOpsHomeDir();

    expect(migrated).toBe(path.join(fakeHome, ".delexec"));
    expect(fs.existsSync(path.join(migrated, "ops.config.json"))).toBe(true);
    expect(fs.existsSync(path.join(migrated, "delexec.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(fakeHome, ".remote-subagent"))).toBe(false);
  });

  it("respects explicit DELEXEC_HOME while still migrating legacy sqlite filenames in place", () => {
    const customHome = fs.mkdtempSync(path.join(os.tmpdir(), "delexec-custom-home-"));
    cleanupDirs.push(customHome);
    process.env.DELEXEC_HOME = customHome;
    delete process.env.CROC_OPS_HOME;

    fs.writeFileSync(path.join(customHome, "croc.sqlite"), "legacy-sqlite", "utf8");

    const resolvedHome = getOpsHomeDir();
    ensureOpsDirectories();

    expect(resolvedHome).toBe(customHome);
    expect(fs.existsSync(path.join(customHome, "delexec.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(customHome, "croc.sqlite"))).toBe(false);
  });
});
