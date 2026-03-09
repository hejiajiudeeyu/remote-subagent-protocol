# L0 Closeout Checklist

This checklist tracks the remaining work before the current L0 implementation can be considered fully closed as a productized, deployable baseline.

## Status Key

- `done`: implemented in the current repository
- `partial`: implemented in a lightweight or prototype form, but not yet complete
- `todo`: still missing

## Deployment And Distribution

- `done` independent deployment profiles for `platform`, `relay`, `buyer`, `seller`, `ops`, and `all-in-one`
- `done` unified end-user package shape through `deploy/ops`
- `done` seller end-user install path defined as `npx @croc/ops`, separate from Docker deployment profiles
- `partial` real deployment transport relay is wired, and compose smoke now classifies network, registry-auth, and image pull failures better, but strict smoke still depends on external image pull stability
- `done` registry publish workflow for versioned images
- `done` released image compatibility matrix and release notes discipline

## Identity And Access

- `done` buyer registration
- `done` seller registration
- `done` buyer can enable seller role on the same user path
- `done` admin key and admin role gating for platform operations
- `done` local API-key bootstrap command that writes buyer credentials into `.env.local`
- `partial` role model exists, but is still minimal and not yet fully productized
- `todo` real login/session flow for consoles
- `todo` secure credential storage beyond env files and browser localStorage

## Platform Operations

- `done` seller/subagent admin listing
- `done` seller/subagent approve, reject, and disable actions
- `done` request admin listing
- `done` audit trail for role, review, and disable actions
- `done` review queue endpoint and console view
- `done` platform console operates these APIs and includes reviewer guidance, reviewer notes, and history/drill-down summaries
- `done` runtime resource state simplified to `enabled / disabled`
- `done` approval lifecycle moved into review records instead of resource status
- `partial` approval history UX can still be deepened, but the core reviewer notes, guidance, and history workflow is in place

## Buyer And Seller Operations

- `done` buyer remote request entrypoint
- `done` buyer background inbox and event sync loops
- `done` seller background inbox and heartbeat loops
- `done` buyer/seller shared console MVP
- `done` ops console supports registration, seller enablement, dispatch, setup wizard guidance, and richer result/runtime views
- `done` seller local config path established at `~/.remote-subagent`
- `done` unified ops client exists for setup/start/status/add-subagent/submit-review/enable-seller/doctor
- `done` local supervisor exists and manages buyer, seller, and relay in the end-user path
- `done` richer request timeline and result views
- `done` onboarding wizard that guides local runtime setup and seller enablement
- `done` editable seller/subagent profile management exists through both CLI and UI

## Search And Discovery

- `done` catalog filters for `task_type`, `capability`, and `tag`
- `done` public catalog defaults to enabled subagents only
- `partial` search exists, but candidate ranking is still basic
- `todo` ranking by availability, success rate, latency, trust, and cost hints
- `todo` richer search dimensions such as domain, input mode, and compliance tags

## Observability

- `done` health endpoints
- `done` metrics summary endpoint
- `done` audit trail endpoint
- `partial` console visibility exists with runtime cards, per-service logs, alerts, and debug snapshots, but not yet time-series observability
- `todo` Prometheus-ready metrics
- `todo` tracing
- `todo` structured log aggregation guidance
- `todo` dashboard-ready time series views

## Testing And Validation

- `done` unit, integration, and e2e suites for the main protocol path
- `done` deployment config validation
- `partial` compose smoke exists and now emits failure classes/diagnostics including Docker Hub auth/token failures, but external Docker registry instability can still block it
- `done` published-image validation in CI
- `partial` UI regression coverage exists for console view models and production builds, but not yet full browser workflows

## Recommended Minimum Bar For L0 Exit

Before calling L0 closed, the recommended minimum remaining bar is:

1. stable compose smoke against published images in non-flaky external environments
2. basic login / credential flow for both consoles
3. documented seller onboarding and approval lifecycle
