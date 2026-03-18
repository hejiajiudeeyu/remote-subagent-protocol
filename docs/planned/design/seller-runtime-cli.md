# Seller Runtime CLI Architecture

## Goal

Make the seller side easy for local coding agents and end users to install and configure on a personal computer.

The intended flow is:

1. A user asks Codex, Claude Code, or another coding agent to install the seller side.
2. The tool runs a small set of stable `npx` commands.
3. A local seller runtime is configured, registered with platform review, and ready to host one or more subagents.

This architecture does **not** treat Codex or Claude Code as subagents. They are installation operators.

## Non-Goals

- Desktop installer in L0
- Docker-first seller install path for end users
- Hook-only integration model
- Rich multi-tenant admin workflow for seller onboarding

## Selected Direction

The seller side will use:

- `npx` / npm as the main install and setup path
- a local seller runtime process
- adapter-based subagent registration
- `process` adapter as the default integration model
- `http` adapter as the secondary integration model

## Why Not Hook-Only

Hook-only integration is too thin for the current protocol model:

- seller needs queueing, signing, ACK, heartbeat, retries, and status
- subagent integration needs a stable request/response contract
- local coding agents install more reliably through explicit CLI commands than through ad-hoc hook scripts

Hook support can exist later as a thin variant of the `process` adapter, but it should not be the primary interface.

## Current User-Facing CLI

The current user-facing package is:

- `@delexec/ops`

The current product-path commands are:

```bash
npx @delexec/ops setup
npx @delexec/ops auth register
npx @delexec/ops add-subagent
npx @delexec/ops submit-review
npx @delexec/ops enable-seller
npx @delexec/ops start
npx @delexec/ops status
npx @delexec/ops doctor
npx @delexec/ops debug-snapshot
```

Compatibility aliases still exist for some legacy `seller ...` subcommands, but they are no longer the documented primary path.

### Command Responsibilities

`setup`

- create local ops config if missing
- generate seller signing keypair if missing
- set default seller identity if missing
- persist config to local env/config files

`enable-seller`

- enable the local seller runtime
- keep local seller state separate from platform review submission

`submit-review`

- submit seller + pending subagent review requests to platform
- persist returned seller API key locally
- mark local subagents as submitted with `review_status=pending`

`start`

- start the local ops supervisor
- start relay and buyer automatically
- start seller when enabled and configured

`status`

- report local seller identity
- report supervisor / buyer / seller / relay runtime status
- report last heartbeat time
- report configured subagents
- report latest platform review state if available

`add-subagent`

- register a local subagent definition in seller config
- validate adapter config
- do not submit review automatically

`doctor`

- validate local config
- validate transport reachability
- validate platform connectivity
- validate adapter targets
- surface clear fix hints

## Local Config Model

The unified ops client uses a stable local config, separate from ad-hoc env-only setup.

Recommended files:

- `~/.delexec/.env.local`
- `~/.delexec/ops.config.json`

`.env.local` remains the simple key/value runtime file:

- `PLATFORM_API_BASE_URL`
- `PLATFORM_API_KEY`
- `SELLER_ID`
- `SELLER_SIGNING_PUBLIC_KEY_PEM`
- `SELLER_SIGNING_PRIVATE_KEY_PEM`
- `TRANSPORT_BASE_URL`

`ops.config.json` holds structured buyer, seller, runtime, and adapter data:

```json
{
  "platform": {
    "base_url": "http://127.0.0.1:8080"
  },
  "buyer": {
    "enabled": true,
    "api_key": "sk_buyer_..."
  },
  "seller": {
    "enabled": true,
    "seller_id": "seller_local_ops",
    "display_name": "Local Seller",
    "subagents": [
      {
        "subagent_id": "local.summary.v1",
        "display_name": "Local Summary Agent",
        "enabled": true,
        "task_types": ["summarize"],
        "capabilities": ["text.summarize"],
        "tags": ["local", "agent"],
        "adapter_type": "process",
        "adapter": {
          "cmd": "python3 /Users/me/agents/summary_agent.py",
          "cwd": "/Users/me/agents",
          "env": {}
        },
        "timeouts": {
          "soft_timeout_s": 60,
          "hard_timeout_s": 180
        }
      }
    ]
  },
  "runtime": {
    "ports": {
      "supervisor": 8079,
      "relay": 8090,
      "buyer": 8081,
      "seller": 8082
    }
  }
}
```

## Adapter Model

### 1. Process Adapter

This is the default and recommended local integration path.

Use it for:

- local scripts
- Python or Node programs
- local coding-agent wrappers
- workflow runners
- command-line tools

Suggested CLI example:

```bash
npx @delexec/ops add-subagent \
  --type process \
  --subagent-id local.summary.v1 \
  --display-name "Local Summary Agent" \
  --cmd "python3 /Users/me/agents/summary_agent.py" \
  --task-type summarize \
  --capability text.summarize
```

Runtime contract:

- seller runtime sends a single JSON payload to stdin
- child process returns a single JSON payload on stdout
- stderr is treated as diagnostic log output
- non-zero exit code becomes a seller execution error

Suggested stdin payload:

```json
{
  "request_id": "req_123",
  "task_type": "summarize",
  "subagent_id": "local.summary.v1",
  "input": {
    "text": "..."
  },
  "constraints": {
    "hard_timeout_s": 120
  }
}
```

Suggested stdout payload:

```json
{
  "status": "ok",
  "output": {
    "summary": "..."
  },
  "usage": {
    "tokens_in": 100,
    "tokens_out": 40
  }
}
```

or

```json
{
  "status": "error",
  "error": {
    "code": "SUBAGENT_FAILED",
    "message": "..."
  }
}
```

### 2. HTTP Adapter

Use it when the local capability already exists as a service.

Suggested CLI example:

```bash
npx @delexec/ops add-subagent \
  --type http \
  --subagent-id local.extractor.v1 \
  --display-name "Local Extractor API" \
  --url http://127.0.0.1:9001/invoke \
  --task-type extract \
  --capability field.extract
```

Contract:

- seller runtime sends a JSON `POST`
- subagent service returns the same normalized `ok/error` structure as the process adapter

### 3. Function Adapter

Keep this for internal demos and tests, not as the main user-facing integration path.

## `add-subagent` Behavior

`add-subagent` should be a local adapter registrar, not just a platform catalog writer.

Current behavior:

1. validate input flags or config file
2. write the subagent definition into `ops.config.json`
3. update runtime-facing env/config if needed
4. leave review submission as an explicit later step via `submit-review`
5. leave the seller runtime able to load the new subagent after restart or reload

### Input Modes

Support both:

1. interactive mode
2. declarative mode

Interactive:

```bash
npx @delexec/ops add-subagent
```

Declarative:

```bash
npx @delexec/ops add-subagent --config ./subagent.json
```

Declarative mode is important for coding-agent installation flows.

## Runtime Loading Model

Current code already supports:

- seller identity with multiple `subagent_ids`
- background heartbeat
- background inbox polling

Current implementation:

- seller identity preserves multiple `subagent_ids`
- seller runtime loads per-subagent adapters from local config
- tasks are routed by `subagent_id`
- seller status endpoints expose configured subagents and adapter summaries

## Remaining Gaps

The main remaining gaps are now product-depth gaps rather than architecture gaps:

1. stronger field validation and recovery hints in the subagent editor
2. richer browser workflow coverage beyond current DOM/view-model tests
3. more advanced observability around adapter performance and failure rates
4. richer search/ranking for seller discovery on the buyer side

## Current Code Touch Points

- `apps/ops/src/cli.js`
- `apps/ops/src/supervisor.js`
- `apps/seller-controller/src/server.js`
- `packages/seller-runtime-core/src/index.js`
- `packages/seller-runtime-core/src/executors.js`
- `apps/ops-console/src/main.js`
- `deploy/ops/README.md`
- `README.md`
