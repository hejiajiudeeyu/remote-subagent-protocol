import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("@delexec/contracts package integration", () => {
  it("packs into a clean-room installable protocol artifact", async () => {
    const rootDir = process.cwd();
    const checkScriptPath = path.join(rootDir, "scripts", "check-contracts-package.mjs");
    const result = await execFileAsync(process.execPath, [checkScriptPath], {
      cwd: rootDir
    });

    expect(result.stdout).toContain("[check-contracts-package] ok");
  }, 30000);
});
