# CLAUDE.md

This repository uses `docs/current/` as the default documentation truth source.

## Start Here

Read in this order before making behavior changes:

1. `docs/current/spec/architecture.md`
2. `docs/current/spec/platform-api-v0.1.md`
3. `docs/current/guides/integration-playbook.md`
4. `docs/current/spec/defaults-v0.1.md`
5. `docs/current/status/current-implementation-status.md`
6. `docs/current/status/current-closeout-checklist.md`

Use `docs/planned/` only for not-yet-implemented designs. Use `docs/archive/` only for historical reference. Use `docs/issues/` for active execution plans that are still in progress (e.g. `docs/issues/direct-use-readiness/`).

## Current Product Position

The repository is:

- protocol-complete for the main buyer/platform/seller path
- pilot-ready for controlled self-hosted use
- not yet production-ready

Current formal blockers to a stronger production claim are:

1. API key rotation and revocation
2. signer key rotation windows
3. Prometheus/tracing/time-series observability
4. secret management is still local-first (no OS keychain or managed secret backend)
5. stronger long-running published-image validation in external environments
6. `platform-console` frontend not yet bundled into `deploy/public-stack`

See `docs/current/guides/product-readiness-boundary.md`.

## Important Runtime Facts

- Formal seller/subagent onboarding exists through `POST /v1/catalog/subagents`
- Seller and subagent each have:
  - `review_status`: `pending | approved | rejected`
  - `status`: `enabled | disabled`
- Public catalog visibility requires seller and subagent to both be `approved` and `enabled`
- Hidden admin review tests exist for platform-direct review harnesses
- Current implemented transport adapters are:
  - `local`
  - `relay-http`
  - `email`
  - `emailengine`
  - `gmail`

Do not describe unimplemented transports or planned roadmap items as current behavior.

## End-User Path

Current supported end-user install path is repo-local:

```bash
npm install
npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080
```

Do not default to `npx @croc/ops` unless packaging/release docs are updated to support that path.

## Operator Path

Current operator-facing deployment entrypoint is:

- `deploy/public-stack/`

Use:

```bash
make deploy-public-stack
```

Read:

- `docs/current/guides/public-stack-operator-guide.md`
- `docs/current/guides/deployment-guide.md`

## Development Rules

- Prefer changing code and tests before changing docs.
- Any externally observable behavior change must update:
  - `docs/current/spec/*`
  - `docs/current/guides/*`
  - `docs/current/diagrams/*` when flow changes
- New error codes must be added to `packages/contracts/src/index.js`
- Do not use `docs/planned/` to justify current runtime behavior
- When changing behavior that affects documentation, consult `docs/current/testing/doc-change-impact-checklist.md`
- When onboarding new subagents, consult `docs/current/testing/subagent-admission-checklist.md`

## Validation

Minimum validation after meaningful changes:

```bash
npm run test:unit
npm run test:integration
npm run test:e2e
```

When changing deploy/runtime wiring, also run:

```bash
npm run test:deploy:config
npm run test:compose-smoke
```

When changing public operator deployment, also run:

```bash
npm run test:public-stack-smoke
```

When preparing a release, also run:

```bash
npm run test:release:docs
npm run test:local-images-smoke
npm run test:published-images-smoke
```

Full CI-equivalent validation:

```bash
npm run test:ci
```
