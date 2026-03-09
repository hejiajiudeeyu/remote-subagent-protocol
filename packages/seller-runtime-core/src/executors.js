import { spawn } from "node:child_process";

export function deferTask(reason = "deferred") {
  return {
    deferred: true,
    reason
  };
}

function normalizeExecutionResult(result) {
  if (!result || typeof result !== "object") {
    return {
      status: "error",
      error: {
        code: "SUBAGENT_INVALID_RESULT",
        message: "subagent returned an invalid result payload",
        retryable: false
      },
      schema_valid: true,
      usage: { tokens_in: 0, tokens_out: 0 }
    };
  }

  if (result.status === "ok" || result.status === "error" || result.deferred === true) {
    return result;
  }

  return {
    status: "ok",
    output: result,
    schema_valid: true,
    usage: { tokens_in: 0, tokens_out: 0 }
  };
}

export function createFunctionExecutor(fn, { name = "function-executor", allowedTaskTypes = null } = {}) {
  if (typeof fn !== "function") {
    throw new TypeError("seller_executor_fn_required");
  }

  return {
    name,
    allowedTaskTypes: Array.isArray(allowedTaskTypes) ? [...allowedTaskTypes] : null,
    async execute(context) {
      return normalizeExecutionResult(await fn(context));
    }
  };
}

async function runProcessAdapter(adapter, context) {
  if (!adapter?.cmd) {
    throw new Error("process_adapter_cmd_required");
  }

  return new Promise((resolve, reject) => {
    const child = spawn(adapter.cmd, {
      cwd: adapter.cwd || process.cwd(),
      env: {
        ...process.env,
        ...(adapter.env || {})
      },
      shell: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          status: "error",
          error: {
            code: "SUBAGENT_PROCESS_EXITED",
            message: stderr.trim() || `process exited with code ${code}`,
            retryable: false
          },
          schema_valid: true,
          usage: { tokens_in: 0, tokens_out: 0 }
        });
        return;
      }

      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : null;
        resolve(normalizeExecutionResult(parsed));
      } catch {
        resolve({
          status: "error",
          error: {
            code: "SUBAGENT_PROCESS_INVALID_JSON",
            message: "process adapter must emit a single JSON payload on stdout",
            retryable: false
          },
          schema_valid: true,
          usage: { tokens_in: 0, tokens_out: 0 }
        });
      }
    });

    child.stdin.write(
      JSON.stringify({
        request_id: context.requestId,
        seller_id: context.sellerId,
        subagent_id: context.subagentId,
        task_type: context.taskType,
        input: context.taskInput,
        payload: context.payload,
        constraints: context.constraints,
        task: context.task
      })
    );
    child.stdin.end();
  });
}

async function runHttpAdapter(adapter, context) {
  if (!adapter?.url) {
    throw new Error("http_adapter_url_required");
  }

  const response = await fetch(adapter.url, {
    method: adapter.method || "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(adapter.headers || {})
    },
    body: JSON.stringify({
      request_id: context.requestId,
      seller_id: context.sellerId,
      subagent_id: context.subagentId,
      task_type: context.taskType,
      input: context.taskInput,
      payload: context.payload,
      constraints: context.constraints,
      task: context.task
    })
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    return {
      status: "error",
      error: {
        code: "SUBAGENT_HTTP_INVALID_JSON",
        message: "http adapter must return JSON",
        retryable: false
      },
      schema_valid: true,
      usage: { tokens_in: 0, tokens_out: 0 }
    };
  }

  if (!response.ok) {
    return {
      status: "error",
      error: {
        code: "SUBAGENT_HTTP_FAILED",
        message: body?.error?.message || body?.message || `http adapter returned ${response.status}`,
        retryable: false
      },
      schema_valid: true,
      usage: { tokens_in: 0, tokens_out: 0 }
    };
  }

  return normalizeExecutionResult(body);
}

export function createConfiguredSubagentExecutor(subagent) {
  const allowedTaskTypes = Array.isArray(subagent?.task_types) ? [...subagent.task_types] : null;

  if (subagent?.adapter_type === "http") {
    return {
      name: `http-adapter:${subagent.subagent_id}`,
      allowedTaskTypes,
      async execute(context) {
        return runHttpAdapter(subagent.adapter, context);
      }
    };
  }

  if (subagent?.adapter_type === "function" && typeof subagent?.adapter?.fn === "function") {
    return createFunctionExecutor(subagent.adapter.fn, {
      name: `function-adapter:${subagent.subagent_id}`,
      allowedTaskTypes
    });
  }

  return {
    name: `process-adapter:${subagent?.subagent_id || "unknown"}`,
    allowedTaskTypes,
    async execute(context) {
      return runProcessAdapter(subagent?.adapter || {}, context);
    }
  };
}

export function createSubagentRouterExecutor(subagents = [], fallback = createSimulatorExecutor()) {
  const enabled = new Map(
    (Array.isArray(subagents) ? subagents : [])
      .filter((item) => item?.subagent_id)
      .map((item) => [item.subagent_id, { definition: item, executor: createConfiguredSubagentExecutor(item) }])
  );

  return {
    name: "subagent-router-executor",
    listSubagents() {
      return Array.from(enabled.values()).map(({ definition }) => ({
        subagent_id: definition.subagent_id,
        display_name: definition.display_name || definition.subagent_id,
        enabled: definition.enabled !== false,
        adapter_type: definition.adapter_type || "process",
        task_types: definition.task_types || [],
        capabilities: definition.capabilities || [],
        tags: definition.tags || []
      }));
    },
    getAllowedTaskTypes(subagentId) {
      return enabled.get(subagentId)?.executor.allowedTaskTypes || fallback?.allowedTaskTypes || null;
    },
    async execute(context) {
      const selected = enabled.get(context.subagentId);
      if (!selected || selected.definition.enabled === false) {
        if (fallback?.execute) {
          return fallback.execute(context);
        }
        return {
          status: "error",
          error: {
            code: "SUBAGENT_NOT_CONFIGURED",
            message: `subagent '${context.subagentId}' is not configured locally`,
            retryable: false
          },
          schema_valid: true,
          usage: { tokens_in: 0, tokens_out: 0 }
        };
      }
      return selected.executor.execute(context);
    }
  };
}

export function createSimulatorExecutor() {
  return createFunctionExecutor(
    async ({ task }) => {
      if (task.simulate === "timeout") {
        return deferTask("timeout");
      }

      if (task.simulate === "token_expired") {
        return {
          status: "error",
          error: {
            code: "AUTH_TOKEN_EXPIRED",
            message: "Token expired during seller validation",
            retryable: false
          },
          schema_valid: true,
          usage: { tokens_in: 0, tokens_out: 0 }
        };
      }

      if (task.simulate === "schema_invalid") {
        return {
          status: "ok",
          output: { malformed_field: true },
          schema_valid: false,
          usage: { tokens_in: 12, tokens_out: 6 }
        };
      }

      if (task.simulate === "reject") {
        return {
          status: "error",
          error: {
            code: "CONTRACT_REJECTED",
            message: "Seller guardrail rejected this task",
            retryable: false
          },
          schema_valid: true,
          usage: { tokens_in: 0, tokens_out: 0 }
        };
      }

      return {
        status: "ok",
        output: {
          summary: "Task completed",
          task_id: task.task_id
        },
        schema_valid: true,
        usage: { tokens_in: 42, tokens_out: 24 }
      };
    },
    { name: "simulator-executor" }
  );
}

export function createExampleFunctionExecutor() {
  return createFunctionExecutor(
    async ({ taskInput, task }) => ({
      status: "ok",
      output: {
        summary: `Handled ${task.task_type || "task"} for ${task.subagent_id}`,
        received: taskInput ?? null
      },
      schema_valid: true,
      usage: { tokens_in: 1, tokens_out: 1 }
    }),
    { name: "example-function-executor" }
  );
}
