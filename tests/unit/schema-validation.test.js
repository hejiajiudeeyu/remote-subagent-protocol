import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function validateWireResult(result, subagentId) {
  expect(result.request_id).toBeTypeOf("string");
  expect(result.result_version).toBe("0.1.0");
  expect(result.subagent_id).toBe(subagentId);
  expect(result.seller_id).toMatch(/^seller_/);
  expect(["ok", "error"]).toContain(result.status);
  expect(result.timing).toBeTypeOf("object");
  if ("usage" in result) {
    expect(result.usage).toBeTypeOf("object");
  }
  expect(result.signature_algorithm).toBe("Ed25519");
  expect(result.signer_public_key_pem).toContain("BEGIN PUBLIC KEY");
  expect(result.signature_base64).toBeTypeOf("string");

  if (result.status === "ok") {
    expect(result.output).toBeTypeOf("object");
    expect(result.error ?? null).toBeNull();
    return;
  }

  expect(result.error).toBeTypeOf("object");
  expect(result.error.code).toBeTypeOf("string");
  expect(result.error.message).toBeTypeOf("string");
}

describe("template schema validation", () => {
  const root = path.resolve(process.cwd(), "docs/templates/subagents");

  for (const subagentId of ["foxlab.text.classifier.v1", "owlworks.data.extractor.v1"]) {
    it(`${subagentId} examples match input/output schemas`, () => {
      const dir = path.resolve(root, subagentId);
      const inputSchema = readJson(path.resolve(dir, "input.schema.json"));
      const outputSchema = readJson(path.resolve(dir, "output.schema.json"));
      const contract = readJson(path.resolve(dir, "example-contract.json"));
      const result = readJson(path.resolve(dir, "example-result.json"));

      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validateInput = ajv.compile(inputSchema);
      const validateOutput = ajv.compile(outputSchema);

      const inputOk = validateInput(contract.task.input);
      expect(inputOk, JSON.stringify(validateInput.errors || [])).toBe(true);

      const outputOk = validateOutput(result.output);
      expect(outputOk, JSON.stringify(validateOutput.errors || [])).toBe(true);
      validateWireResult(result, subagentId);
    });
  }
});
