import { describe, expect, it } from "vitest";

import {
  createFunctionExecutor,
  createSimulatorExecutor,
  createSubagentRouterExecutor,
  deferTask
} from "@delexec/seller-runtime-core";

describe("deferTask", () => {
  it("returns deferred marker with default reason", () => {
    expect(deferTask()).toEqual({ deferred: true, reason: "deferred" });
  });

  it("returns deferred marker with custom reason", () => {
    expect(deferTask("timeout")).toEqual({ deferred: true, reason: "timeout" });
  });
});

describe("createFunctionExecutor", () => {
  it("throws TypeError when fn is not a function", () => {
    expect(() => createFunctionExecutor("not-a-function")).toThrow(TypeError);
    expect(() => createFunctionExecutor("not-a-function")).toThrow("seller_executor_fn_required");
  });

  it("throws TypeError for null", () => {
    expect(() => createFunctionExecutor(null)).toThrow(TypeError);
  });

  it("creates executor with name and allowedTaskTypes", () => {
    const executor = createFunctionExecutor(async () => ({ status: "ok", output: {} }), {
      name: "test-exec",
      allowedTaskTypes: ["text.classify"]
    });

    expect(executor.name).toBe("test-exec");
    expect(executor.allowedTaskTypes).toEqual(["text.classify"]);
  });

  it("sets allowedTaskTypes to null when not array", () => {
    const executor = createFunctionExecutor(async () => ({}), {
      allowedTaskTypes: "not-array"
    });
    expect(executor.allowedTaskTypes).toBeNull();
  });

  it("normalizes non-status result as ok output", async () => {
    const executor = createFunctionExecutor(async () => ({
      summary: "raw output without status"
    }));

    const result = await executor.execute({});
    expect(result.status).toBe("ok");
    expect(result.output.summary).toBe("raw output without status");
  });

  it("normalizes null result as error", async () => {
    const executor = createFunctionExecutor(async () => null);

    const result = await executor.execute({});
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("SUBAGENT_INVALID_RESULT");
  });

  it("normalizes undefined result as error", async () => {
    const executor = createFunctionExecutor(async () => undefined);

    const result = await executor.execute({});
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("SUBAGENT_INVALID_RESULT");
  });

  it("normalizes string result as error", async () => {
    const executor = createFunctionExecutor(async () => "just a string");

    const result = await executor.execute({});
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("SUBAGENT_INVALID_RESULT");
  });

  it("normalizes number result as error", async () => {
    const executor = createFunctionExecutor(async () => 42);

    const result = await executor.execute({});
    expect(result.status).toBe("error");
  });

  it("passes through ok result as-is", async () => {
    const executor = createFunctionExecutor(async () => ({
      status: "ok",
      output: { result: "pass-through" },
      schema_valid: true,
      usage: { tokens_in: 1, tokens_out: 1 }
    }));

    const result = await executor.execute({});
    expect(result.status).toBe("ok");
    expect(result.output.result).toBe("pass-through");
  });

  it("passes through error result as-is", async () => {
    const executor = createFunctionExecutor(async () => ({
      status: "error",
      error: { code: "CUSTOM_ERROR", message: "fail" }
    }));

    const result = await executor.execute({});
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("CUSTOM_ERROR");
  });

  it("passes through deferred result as-is", async () => {
    const executor = createFunctionExecutor(async () => deferTask("slow"));

    const result = await executor.execute({});
    expect(result.deferred).toBe(true);
    expect(result.reason).toBe("slow");
  });
});

describe("createSimulatorExecutor", () => {
  const simulator = createSimulatorExecutor();

  it("returns success for normal task", async () => {
    const result = await simulator.execute({
      task: { task_type: "text.classify", task_id: "t1" }
    });
    expect(result.status).toBe("ok");
    expect(result.output.summary).toBe("Task completed");
  });

  it("returns deferred for simulate=timeout", async () => {
    const result = await simulator.execute({
      task: { simulate: "timeout" }
    });
    expect(result.deferred).toBe(true);
  });

  it("returns AUTH_TOKEN_EXPIRED for simulate=token_expired", async () => {
    const result = await simulator.execute({
      task: { simulate: "token_expired" }
    });
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("AUTH_TOKEN_EXPIRED");
  });

  it("returns schema_valid=false for simulate=schema_invalid", async () => {
    const result = await simulator.execute({
      task: { simulate: "schema_invalid" }
    });
    expect(result.status).toBe("ok");
    expect(result.schema_valid).toBe(false);
  });

  it("returns CONTRACT_REJECTED for simulate=reject", async () => {
    const result = await simulator.execute({
      task: { simulate: "reject" }
    });
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("CONTRACT_REJECTED");
  });
});

describe("createSubagentRouterExecutor", () => {
  it("routes to configured subagent", async () => {
    const router = createSubagentRouterExecutor([
      {
        subagent_id: "agent.v1",
        adapter_type: "function",
        adapter: {
          fn: async () => ({
            status: "ok",
            output: { routed: true },
            schema_valid: true,
            usage: { tokens_in: 0, tokens_out: 0 }
          })
        }
      }
    ]);

    const result = await router.execute({ subagentId: "agent.v1", task: {} });
    expect(result.status).toBe("ok");
    expect(result.output.routed).toBe(true);
  });

  it("falls back to default executor when subagent not found", async () => {
    const router = createSubagentRouterExecutor([]);
    const result = await router.execute({
      subagentId: "unknown.agent",
      task: { task_type: "text.classify" }
    });
    expect(result.status).toBe("ok");
    expect(result.output.summary).toBe("Task completed");
  });

  it("returns SUBAGENT_NOT_CONFIGURED when no fallback", async () => {
    const router = createSubagentRouterExecutor([], null);
    const result = await router.execute({
      subagentId: "unknown.agent",
      task: {}
    });
    expect(result.status).toBe("error");
    expect(result.error.code).toBe("SUBAGENT_NOT_CONFIGURED");
  });

  it("falls back when subagent is disabled", async () => {
    const router = createSubagentRouterExecutor(
      [
        {
          subagent_id: "agent.v1",
          enabled: false,
          adapter_type: "function",
          adapter: { fn: async () => ({ status: "ok", output: {} }) }
        }
      ],
      createSimulatorExecutor()
    );

    const result = await router.execute({
      subagentId: "agent.v1",
      task: { task_type: "test" }
    });
    expect(result.status).toBe("ok");
    expect(result.output.summary).toBe("Task completed");
  });

  it("lists configured subagents", () => {
    const router = createSubagentRouterExecutor([
      {
        subagent_id: "agent.v1",
        display_name: "Agent One",
        adapter_type: "function",
        task_types: ["text.classify"],
        capabilities: ["nlp"],
        tags: ["fast"],
        adapter: { fn: async () => ({}) }
      }
    ]);

    const list = router.listSubagents();
    expect(list).toHaveLength(1);
    expect(list[0].subagent_id).toBe("agent.v1");
    expect(list[0].display_name).toBe("Agent One");
    expect(list[0].task_types).toEqual(["text.classify"]);
  });

  it("returns allowed task types for configured subagent", () => {
    const router = createSubagentRouterExecutor([
      {
        subagent_id: "agent.v1",
        adapter_type: "function",
        task_types: ["text.classify", "text.summarize"],
        adapter: { fn: async () => ({}) }
      }
    ]);

    expect(router.getAllowedTaskTypes("agent.v1")).toEqual(["text.classify", "text.summarize"]);
  });

  it("returns fallback task types for unknown subagent", () => {
    const fallback = createFunctionExecutor(async () => ({}), {
      allowedTaskTypes: ["fallback.type"]
    });
    const router = createSubagentRouterExecutor([], fallback);
    expect(router.getAllowedTaskTypes("unknown")).toEqual(["fallback.type"]);
  });

  it("handles empty subagents array", () => {
    const router = createSubagentRouterExecutor([]);
    expect(router.listSubagents()).toEqual([]);
  });

  it("handles non-array subagents input", () => {
    const router = createSubagentRouterExecutor(null);
    expect(router.listSubagents()).toEqual([]);
  });
});
