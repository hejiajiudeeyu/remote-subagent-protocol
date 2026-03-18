import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "contracts-pack-check-"));
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "install");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  try {
    const packed = await execFileAsync(
      "npm",
      ["pack", "--workspace", "@delexec/contracts", "--pack-destination", packDir],
      {
        cwd: ROOT_DIR
      }
    );
    const tarballName = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
    if (!tarballName) {
      throw new Error("contracts_pack_missing_tarball_name");
    }

    const tarballPath = path.join(packDir, tarballName);
    await execFileAsync("npm", ["init", "-y"], { cwd: installDir });
    await execFileAsync("npm", ["install", tarballPath], { cwd: installDir });

    const checkScript = `
      import fs from "node:fs";
      import {
        REQUEST_STATUS,
        getBundledProtocolDocsRoot,
        getBundledTemplatesRoot,
        hasBundledProtocolAssets,
        loadBundledTemplateManifest,
        resolveBundledTemplatePath
      } from "@delexec/contracts";

      if (REQUEST_STATUS.SUCCEEDED !== "SUCCEEDED") {
        throw new Error("contracts_request_status_export_missing");
      }
      if (!hasBundledProtocolAssets()) {
        throw new Error("contracts_protocol_assets_missing");
      }

      const manifest = loadBundledTemplateManifest();
      const inputSchemaPath = resolveBundledTemplatePath("subagents/local.summary.v1/input.schema.json");
      if (!fs.existsSync(inputSchemaPath)) {
        throw new Error("contracts_template_input_schema_missing");
      }
      if (!manifest.subagents.some((entry) => entry.subagent_id === "local.summary.v1")) {
        throw new Error("contracts_template_manifest_missing_local_summary");
      }
      if (!fs.existsSync(getBundledTemplatesRoot())) {
        throw new Error("contracts_templates_root_missing");
      }
      if (!fs.existsSync(getBundledProtocolDocsRoot())) {
        throw new Error("contracts_protocol_docs_root_missing");
      }

      console.log(JSON.stringify({
        ok: true,
        packaged_subagents: manifest.subagents.length,
        catalog_templates: manifest.catalog_templates.length
      }));
    `;

    const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", checkScript], {
      cwd: installDir
    });
    const payload = JSON.parse(result.stdout.trim());

    if (payload.ok !== true || payload.packaged_subagents < 1 || payload.catalog_templates < 1) {
      throw new Error("contracts_package_validation_failed");
    }

    console.log(
      `[check-contracts-package] ok tarball=${tarballName} subagents=${payload.packaged_subagents} catalog_templates=${payload.catalog_templates}`
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[check-contracts-package] ${error.stack || error.message}`);
  process.exit(1);
});
