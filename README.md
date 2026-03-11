<div align="center">
  <h1>Remote Subagent Protocol</h1>
  <p><em>An open protocol for delegated remote execution between buyer agents and remote subagents</em></p>
</div>

English | [中文](README.zh-CN.md)

---

## Overview

`Remote Subagent Protocol` defines how a buyer-side local agent discovers a remote subagent, authorizes a task, delivers a contract, verifies a signed result, and accumulates trust signals across repeated calls.

`Remote` refers to the execution and trust boundary, not necessarily cross-network deployment. A single-host `L0 local transport` setup still models remote execution semantics if the buyer and seller remain separate protocol actors.

The protocol is motivated by a common gap in current agent systems: once a task needs external tools, private infrastructure, domain-specific workflows, or human-maintained runtimes, integration usually falls back to ad hoc APIs, prompt conventions, and product-specific glue code. That makes remote capability reuse hard to standardize, hard to verify, and hard to port across host agents. `Remote Subagent Protocol` addresses this by defining a transport-neutral, contract-first call path for discovery, authorization, delivery, signed results, and trust accumulation, so a buyer agent can invoke a remote skill as a protocol capability instead of a one-off integration.

This repository is the protocol source of truth and currently includes:

- protocol architecture and control-plane specifications
- reference implementations for buyer-side local agent, seller-side remote subagent runtime, and platform controllers
- contract templates, schemas, diagrams, and integration guides
- test suites for unit, integration, e2e, and compose smoke flows

Current implemented result-delivery baseline:

- platform issues request-scoped `delivery-meta` with both `task_delivery` and `result_delivery`
- seller returns a pure JSON result body; buyer controller parses and verifies it before exposing it upstream
- file outputs travel as attachments described by signed `artifacts[]` metadata
- `platform_inbox` is reserved in the protocol but not implemented in the current runtime

## Repository Scope

This repository is protocol-first. Implementation-specific product logic, distribution strategy, operational workflows, and other non-protocol concerns should live outside this repository and depend on this protocol source of truth instead of redefining it.

## Core Documents

- [L0 Document Index](docs/l0/README.md)
- [Architecture Baseline](docs/l0/architecture.md)
- [Protocol Control Plane API](docs/l0/platform-api-v0.1.md)
- [Integration Playbook](docs/l0/integration-playbook.md)
- [Defaults v0.1](docs/l0/defaults-v0.1.md)
- [Post-L0 Evolution](docs/post-l0-evolution.md)
- [Scope Guidance](docs/remote-subagent-scope.md)
- [Buyer Skill Integration Guide](docs/buyer-remote-subagent-skills.md)
- [OpenClaw Adapter Guide](docs/openclaw-adapter.md)
- [Diagram Index](docs/diagrams/README.md)
- [Development Tracker](docs/l0/development-tracker.md)
- [L0 Closeout Checklist](docs/l0/l0-closeout-checklist.md)
- [Deployment Guide](docs/deployment-guide.md)
- [Release Process](docs/release-process.md)
- [Release Compatibility Matrix](docs/releases/compatibility-matrix.md)
- [Protocol Playground](site/protocol-playground.html)

## Reference Implementations

- [Platform API](apps/platform-api)
- [Buyer Controller](apps/buyer-controller)
- [Seller Controller](apps/seller-controller)
- [Contracts Package](packages/contracts)
- [Transport Packages](packages/transports)

## End-User Ops Client

- `npm run ops -- setup` to initialize the unified local ops client under `~/.remote-subagent`
- `npm run ops -- auth register --email you@example.com --platform http://127.0.0.1:8080` to register a buyer API key
- `npm run ops -- add-subagent --type process --subagent-id local.echo.v1 --cmd "node worker.js"` to attach a local seller subagent
- `npm run ops -- remove-subagent --subagent-id local.echo.v1` to remove a local seller subagent from the machine
- `npm run ops -- disable-subagent --subagent-id local.echo.v1` to disable a local seller subagent without deleting it
- `npm run ops -- enable-subagent --subagent-id local.echo.v1` to re-enable a disabled local seller subagent
- `npm run ops -- submit-review` to submit pending local seller subagents for platform review
- `npm run ops -- enable-seller` to enable the local seller runtime after setup/review submission
- `npm run ops -- start` to run the local supervisor, buyer, and relay
- `npm run ops -- doctor` to run local runtime and adapter checks
- `npm run ops -- debug-snapshot` to export a local debug snapshot with recent events and log tails

## Repo Development And Test Commands

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:compose-smoke`

## Web Consoles

- `npm run dev:ops-console` for the shared buyer/seller user console
- `npm run dev:platform-console` for the platform admin console (use `PLATFORM_ADMIN_API_KEY`)
- `ops-console` now includes a setup wizard, request timeline/result panels, runtime alerts, and local debug snapshot support
- `platform-console` now includes reviewer guidance, review/audit history summaries, and reviewer note-driven approve/reject/disable actions
- Seller CLI/runtime architecture: [docs/design/seller-runtime-cli.md](docs/design/seller-runtime-cli.md)

## Deployment Profiles

- End-user buyer/seller install path: `npx @croc/ops setup -> auth register -> add-subagent -> submit-review -> enable-seller -> start`
- For the full end-user sequence and troubleshooting notes, see [deploy/ops](deploy/ops)
- End-user local logs are written under `~/.remote-subagent/logs`, and `ops-console` reads them through the supervisor
- Docker/Compose remains the recommended path for platform, relay, CI, local integration, and advanced standalone deployments
- `make deploy-platform` for standalone `platform-api` + PostgreSQL
- `make deploy-ops` for the combined end-user package (buyer by default, seller optional)
- `make deploy-relay` for shared transport relay
- `make deploy-buyer` for standalone `buyer-controller`
- `make deploy-seller` for standalone `seller-controller`
- `make deploy-all` for single-host local integration

Deployment entrypoints live under:

- [deploy/platform](deploy/platform)
- [deploy/ops](deploy/ops)
- [deploy/relay](deploy/relay)
- [deploy/buyer](deploy/buyer)
- [deploy/seller](deploy/seller)
- [deploy/all-in-one](deploy/all-in-one)

## License

[Apache License 2.0](LICENSE)
