export function deferTask(reason = "deferred") {
  return {
    deferred: true,
    reason
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
      return fn(context);
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
