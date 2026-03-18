import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_EXAMPLE_SUBAGENT_ID = "local.summary.v1";
export const LOCAL_EXAMPLE_DISPLAY_NAME = "Local Summary Example";
export const LOCAL_EXAMPLE_TASK_TYPE = "text_summarize";
export const LOCAL_EXAMPLE_CAPABILITY = "text.summarize";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function quoteShellArg(value) {
  return JSON.stringify(String(value));
}

export function resolveExampleWorkerPath() {
  return path.resolve(__dirname, "example-subagent-worker.js");
}

export function buildExampleSubagentDefinition() {
  return {
    subagent_id: LOCAL_EXAMPLE_SUBAGENT_ID,
    display_name: LOCAL_EXAMPLE_DISPLAY_NAME,
    enabled: true,
    task_types: [LOCAL_EXAMPLE_TASK_TYPE],
    capabilities: [LOCAL_EXAMPLE_CAPABILITY],
    tags: ["local", "example", "demo"],
    adapter_type: "process",
    adapter: {
      cmd: `${quoteShellArg(process.execPath)} ${quoteShellArg(resolveExampleWorkerPath())}`
    },
    timeouts: {
      soft_timeout_s: 60,
      hard_timeout_s: 180
    },
    review_status: "local_only",
    submitted_for_review: false
  };
}

export function buildExampleRequestBody({
  text,
  sellerId,
  subagentId = LOCAL_EXAMPLE_SUBAGENT_ID,
  signerPublicKeyPem = null
} = {}) {
  const payloadText = String(text || "Summarize this local example request.").trim();
  return {
    seller_id: sellerId,
    subagent_id: subagentId,
    expected_signer_public_key_pem: signerPublicKeyPem,
    task_type: LOCAL_EXAMPLE_TASK_TYPE,
    input: { text: payloadText },
    payload: { text: payloadText },
    output_schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string" }
      }
    }
  };
}

export function summarizeExampleText(text) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (!value) {
    return "No input text provided.";
  }
  if (value.length <= 120) {
    return value;
  }
  return `${value.slice(0, 117)}...`;
}
