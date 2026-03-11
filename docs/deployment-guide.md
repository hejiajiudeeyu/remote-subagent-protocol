# Deployment Guide

This guide covers the supported deployment shapes for `platform`, `buyer`, and `seller`.

Current protocol/runtime baseline:

- platform returns request-scoped `delivery-meta` with `task_delivery` and `result_delivery`
- seller result mail uses a pure JSON body; buyer-controller parses and verifies it before exposing it upstream
- file outputs may travel as attachments described by signed `artifacts[]`
- `platform_inbox` is reserved for future evolution and is not implemented in current deployments

## Recommended Install Paths

- `platform` and `relay`: prefer Docker/Compose deployment
- `buyer` and `seller` on an end-user machine: prefer the unified `npx @croc/ops ...` path
- Docker/Compose remains appropriate for CI, local integration, and advanced standalone deployment

## Supported Profiles

- `deploy/platform`: platform API plus PostgreSQL
- `deploy/ops`: end-user package with buyer always on and seller as an opt-in local role
- `deploy/relay`: shared transport relay
- `deploy/buyer`: standalone buyer controller, SQLite by default
- `deploy/seller`: standalone seller controller deployment profile for operators and CI
- `deploy/all-in-one`: local integration stack

## Seller CLI Path

Recommended user path:

1. `npx @croc/ops setup`
2. `npx @croc/ops auth register --email you@example.com --platform http://127.0.0.1:8080`
3. `npx @croc/ops add-subagent --type process --subagent-id local.echo.v1 --cmd "node worker.js"`
4. `npx @croc/ops submit-review`
5. `npx @croc/ops enable-seller`
6. `npx @croc/ops start`
7. `npx @croc/ops doctor` / `npx @croc/ops debug-snapshot`

This path stores local ops state under `~/.remote-subagent`, starts a local supervisor, and manages relay internally.
Local runtime logs are written under `~/.remote-subagent/logs`, and `ops-console` reads logs and debug snapshot data from the supervisor.
`ops-console` also provides a setup wizard that guides the user through buyer registration, local subagent attachment, review submission, and seller enablement.
`enable-seller` only enables the local seller runtime. Platform review controls catalog visibility and remote availability; it does not prevent the local runtime from starting.

## Image Distribution

Each deploy profile accepts:

- `IMAGE_REGISTRY`
- `IMAGE_TAG`

Default image names:

- `rsp-relay`
- `rsp-platform`
- `rsp-buyer`
- `rsp-seller`

## Platform Admin Access

Set `PLATFORM_ADMIN_API_KEY` on the platform deployment if you want a stable operator credential for `platform-console`.

- `platform-console` should use `PLATFORM_ADMIN_API_KEY`
- buyer credentials no longer imply operator access
- a user can still be granted the `admin` role later through the admin role-grant endpoint

Current compose files keep both `image` and `build` so local source builds still work. In a registry-backed environment, set `IMAGE_REGISTRY` and `IMAGE_TAG` to the published image coordinates.

## Relay

The relay is the shared transport runtime between buyer and seller controllers in deployment mode.

For the end-user ops client, relay is started and managed by the local supervisor by default.
Standalone relay deployment is mainly for CI, local integration, and advanced operator-managed environments.

- Buyer and seller both require `TRANSPORT_BASE_URL`
- The relay can run with SQLite persistence via `RELAY_SQLITE_PATH`
- `local://relay/<receiver>/...` delivery addresses resolve to relay receivers

## Storage Choices

### Platform

- Recommended: PostgreSQL
- Reason: platform state is shared control-plane state and should not depend on single-node SQLite

### Buyer

- Default: SQLite via `SQLITE_DATABASE_PATH`
- Recommended upgrade path: set `DATABASE_URL` when buyer must survive container replacement or run with external operations tooling
- Precedence: `DATABASE_URL` overrides `SQLITE_DATABASE_PATH`

### Seller

- Default: SQLite via `SQLITE_DATABASE_PATH`
- Recommended upgrade path: set `DATABASE_URL` for multi-instance or persistent production runtime
- Precedence: `DATABASE_URL` overrides `SQLITE_DATABASE_PATH`

## Seller Signing Keys

Seller signing is optional for local demos but should be treated as required for non-demo deployments.

Configure both variables together:

- `SELLER_SIGNING_PUBLIC_KEY_PEM`
- `SELLER_SIGNING_PRIVATE_KEY_PEM`

Rules:

- Do not provide only one of the two values; startup fails on incomplete key pairs
- Encode multiline PEM values as escaped newlines when using `.env`
- Prefer secret injection from your runtime platform instead of committing PEM values into env files

Example format:

```env
SELLER_SIGNING_PUBLIC_KEY_PEM=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
SELLER_SIGNING_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

For `platform` bootstrap mode, the matching variables are:

- `BOOTSTRAP_SELLER_PUBLIC_KEY_PEM`
- `BOOTSTRAP_SELLER_PRIVATE_KEY_PEM`
- `BOOTSTRAP_SELLER_API_KEY`

Use the same seller identity and key pair on both `platform` and `seller` when running them as separate deployments.

## Deployment Recommendations

- `platform`: publish and deploy as a server-side image with managed PostgreSQL
- `buyer`: support both container deployment and direct embedding; use Docker when you want standardized operations
- `seller`: prefer `npx @croc/ops` on end-user machines, and use container deployment for operator-managed standalone services

## Release Shape

Recommended image tagging model:

- immutable tag: git SHA
- human tag: release version such as `0.1.0`
- optional channel tag: `latest`

Recommended publish order:

1. publish shared test results
2. publish `rsp-platform`, `rsp-buyer`, `rsp-seller`
3. update deploy examples to the released `IMAGE_TAG`
