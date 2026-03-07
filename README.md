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
- [Protocol Playground](site/protocol-playground.html)

## Reference Implementations

- [Platform API](apps/platform-api)
- [Buyer Controller](apps/buyer-controller)
- [Seller Controller](apps/seller-controller)
- [Contracts Package](packages/contracts)
- [Transport Packages](packages/transports)

## Running The Repo

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:compose-smoke`

## License

[Apache License 2.0](LICENSE)
