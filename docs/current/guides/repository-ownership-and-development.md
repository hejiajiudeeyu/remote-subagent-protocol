# Repository Ownership And Development

This document freezes the post-split repository model.

## Active Repositories

### `delegated-execution-protocol`

Owns:

- `@delexec/contracts`
- protocol schemas, validation helpers, error registry, enums
- signing and canonicalization rules
- protocol templates and truth-source documentation

Does not own:

- buyer or seller runtime behavior
- end-user CLI flows
- operator deployment and Docker packaging

Use this repository first when you need to change the protocol itself.

### `delegated-execution-client`

Owns:

- `@delexec/ops`
- local buyer and seller runtime orchestration
- local state, secret store, SQLite-backed client persistence
- client-side transports and end-user onboarding flows

Does not own:

- protocol truth-source definitions
- operator-facing platform deployment

Use this repository first when you need to change the end-user CLI or local runtime behavior.

### `delegated-execution-platform-selfhost`

Owns:

- platform API, relay, operator gateway, and platform-side persistence
- Dockerfiles, GHCR images, and `docker compose` deployment surfaces
- operator environment templates and self-hosted deployment docs

Does not own:

- protocol truth-source definitions
- the end-user `delexec-ops` installation experience

Use this repository first when you need to change self-hosted server behavior or deployment.

## Product Entrypoints

- Protocol consumers install `@delexec/contracts`.
- End users install `@delexec/ops` and use `delexec-ops`.
- Operators deploy the platform through Docker images and `docker compose`.

Internal packages may continue to exist for build, test, and release support, but they are not the primary product surface.

## Recommended Development Flow

1. Start with `delegated-execution-protocol` if the change affects schemas, request/result semantics, compatibility rules, or bundled templates.
2. Release the new `@delexec/contracts` version.
3. Update `delegated-execution-client` and `delegated-execution-platform-selfhost` to consume that released version.
4. Implement repository-specific runtime or deployment changes in the owning repository.
5. Run repository-local CI and packaging checks before publishing.

## Release Order

1. `@delexec/contracts`
2. Shared client support packages only when another repository still depends on them
3. `@delexec/ops`
4. Platform Docker images and compose deployment artifacts

## Long-Term Public Surfaces

The intended long-term public surfaces are:

- protocol: `@delexec/contracts`
- client: `@delexec/ops`
- platform: GHCR images plus compose entrypoints

Other packages may remain published during the split transition, but they should be treated as support artifacts rather than the main public product model.

## Development Rules

- Do not put implementation-specific runtime logic back into the protocol repository.
- Do not make end users assemble client internals manually; keep `@delexec/ops` as the primary client surface.
- Do not make operators install platform services through npm; keep Docker and compose as the primary platform surface.
- Keep cross-repository dependencies explicit and versioned through published artifacts.
