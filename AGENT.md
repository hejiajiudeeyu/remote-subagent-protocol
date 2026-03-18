# AGENT.md

Agent guidance for this repository.

## Documentation Source Of Truth

Default to `docs/current/`.

- `docs/current/` = current implemented truth
- `docs/planned/` = not yet implemented
- `docs/archive/` = historical snapshots only
- `docs/issues/` = active execution plans still in progress

Do not start from historical `L0` assumptions. Those files were migrated into the current/planned/archive split.

## Read Order

For protocol or runtime work:

1. `docs/current/spec/architecture.md`
2. `docs/current/spec/platform-api-v0.1.md`
3. `docs/current/guides/integration-playbook.md`
4. `docs/current/spec/defaults-v0.1.md`
5. relevant runtime code in `apps/*/src` and `packages/*/src`
6. relevant integration/e2e tests

For deploy and operations work:

1. `docs/current/guides/deployment-guide.md`
2. `docs/current/guides/public-stack-operator-guide.md`
3. `deploy/*`
4. `tests/smoke/*`

For testing and validation work:

1. `docs/current/testing/testing-strategy.md`
2. `docs/current/testing/doc-change-impact-checklist.md`
3. `docs/current/testing/subagent-admission-checklist.md`
4. `docs/current/testing/real-linkup-gap-checklist.md`

## Current State

The main protocol path is implemented.

What is already in place:

- buyer/platform/seller reference implementations
- buyer skill adapter
- formal onboarding and dual approval
- hidden review tests
- public operator stack
- local end-user bootstrap path
- encrypted local secret store and local console session model
- transport adapters: `local`, `relay-http`, `email`, `emailengine`, `gmail`

What still blocks a stronger production-ready claim:

- key rotation and revocation
- signer key rotation windows
- Prometheus-ready metrics
- tracing
- dashboard-ready time-series observability
- secret management is still local-first (no OS keychain or managed secret backend)
- more burn-in for published-image validation in external environments
- `platform-console` frontend not yet bundled into `deploy/public-stack`

Reference:

- `docs/current/guides/product-readiness-boundary.md`
- `docs/current/status/current-closeout-checklist.md`

## Repository Structure

Apps (`apps/`):

- `platform-api` — protocol control plane
- `platform-console` — operator web console
- `platform-console-gateway` — local gateway for console (browser never holds admin key directly)
- `ops` — end-user CLI (`npm run ops -- ...`)
- `ops-console` — local operator console with passphrase session
- `transport-relay` — relay transport server
- `buyer-controller` — buyer-side controller
- `buyer-skill-adapter` — buyer skill adapter for agent integration
- `seller-controller` — seller-side controller

Packages (`packages/`):

- `contracts` — shared error codes, status enums, and structured error builders
- `buyer-controller-core` — buyer controller core logic
- `seller-runtime-core` — seller runtime core logic
- `sqlite-store` — SQLite storage backend
- `postgres-store` — PostgreSQL storage backend
- `transports/` — transport adapters: `local`, `relay-http`, `email`, `emailengine`, `gmail`

## Paths To Use

End-user local path:

```bash
npm install
npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080
```

Operator public path:

```bash
make deploy-public-stack
```

Makefile convenience targets are available for common operations:

- `make test` / `make test-unit` / `make test-integration` / `make test-e2e`
- `make deploy-platform` / `make deploy-public-stack` / `make deploy-all`
- `make test-compose-smoke` / `make test-public-stack-smoke`

## Change Discipline

- Update tests with behavior changes.
- Update `docs/current/*` when external behavior changes.
- Keep `docs/planned/*` for roadmap/design only.
- Keep `docs/issues/*` for active execution plans; move to `docs/current/` or `docs/archive/` when closed.
- Keep release claims aligned with `docs/current/guides/product-readiness-boundary.md`.
- Add new standard error codes to `packages/contracts/src/index.js`.
- When changing behavior that affects documentation, consult `docs/current/testing/doc-change-impact-checklist.md`.

## Release Caution

Do not claim the project is fully production-ready unless at least these are closed:

1. key lifecycle (rotation and revocation)
2. observability (Prometheus, tracing, time-series)
3. secret management beyond local-first
4. stable published-image validation
5. `platform-console` bundled into `deploy/public-stack`

Current accepted wording is closer to:

- `pilot-ready`
- `controlled self-hosted use`
- `reference implementation`
