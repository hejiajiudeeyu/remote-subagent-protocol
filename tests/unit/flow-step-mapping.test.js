import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function collectDiagramStepIds(markdown) {
  const ids = new Set();
  const pattern = /\[([A-Z][A-Z0-9\-]+)\]/g;
  for (const match of markdown.matchAll(pattern)) {
    const id = match[1];
    if (id === "CROC" || id === "TASK") {
      continue;
    }
    ids.add(id);
  }
  return ids;
}

function collectReferencedStepIdsFromE2e(source) {
  const ids = new Set();

  const flowPattern = /flow_step_id:\s*"([A-Z][A-Z0-9\-]+)"/g;
  for (const match of source.matchAll(flowPattern)) {
    ids.add(match[1]);
  }

  const fallbackPattern = /fallbackStepId:\s*"([A-Z][A-Z0-9\-]+)"/g;
  for (const match of source.matchAll(fallbackPattern)) {
    ids.add(match[1]);
  }

  return ids;
}

describe("flow step id mapping", () => {
  it("keeps e2e referenced flow_step_id aligned with sequence diagram", () => {
    const diagramPath = path.resolve(process.cwd(), "docs/current/diagrams/user-remote-subagent-call-flow.md");
    const diagramText = readText(diagramPath);
    const diagramIds = collectDiagramStepIds(diagramText);

    const e2eDir = path.resolve(process.cwd(), "tests/e2e");
    const testFiles = fs
      .readdirSync(e2eDir)
      .filter((name) => name.endsWith(".test.js"))
      .map((name) => path.resolve(e2eDir, name));

    const missing = [];
    for (const filePath of testFiles) {
      const content = readText(filePath);
      const referenced = collectReferencedStepIdsFromE2e(content);
      for (const stepId of referenced) {
        if (!diagramIds.has(stepId)) {
          missing.push({ file: path.basename(filePath), stepId });
        }
      }
    }

    expect(missing, `unmapped flow_step_id: ${JSON.stringify(missing)}`).toEqual([]);
  });
});
