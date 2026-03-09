# Release Process

This repository uses a minimal L0 release process.

## Goals

- produce versioned container images for `platform`, `buyer`, `seller`, and `relay`
- validate both source-build compose paths and image-based compose paths
- keep the release bar small enough for L0 while preserving repeatability

## Image Tags

Recommended tags:

- immutable: git SHA
- release: `vX.Y.Z`
- optional moving tag: `latest` on release tags

## CI Expectations

- `CI` runs unit, integration, e2e, deploy-config, standalone deploy smoke, and compose smoke
- `CI` also runs a local image-based smoke against `deploy/all-in-one` using release-shaped image coordinates
- `Images` builds release images on pull requests and can push them on release tags or manual dispatch
- `CI` checks that the current repository version has a matching release note file and compatibility matrix entry
- `compose-smoke` classifies failures so image pull/network issues can be distinguished from service health or scenario failures

## Recommended Release Steps

1. cut a version tag such as `v0.1.0`
2. let the `Images` workflow publish `rsp-platform`, `rsp-buyer`, `rsp-seller`, and `rsp-relay`
3. ensure `docs/releases/vX.Y.Z.md` exists and `docs/releases/compatibility-matrix.md` includes the tag
4. verify the matching `CI` run passed image-based smoke
5. update any external deployment environment to the released `IMAGE_TAG`

## Compose Smoke Failure Classes

- `image_pull_failed`: base image or registry/network pull problem
  - includes Docker Hub auth/token fetch failures such as `failed to fetch oauth token`, `failed to authorize`, or registry EOF during image resolution
- `port_conflict`: local port allocation problem
- `compose_up_failed`: generic compose start failure
- `health_check_timeout`: services did not become healthy in time
- `postgres_crud_check_failed`: database booted but failed basic CRUD
- `register_failed` / `catalog_failed` / `buyer_remote_request_failed` / `ack_not_ready` / `buyer_result_not_ready`: business-path regression

## Compatibility Note

For L0, compatibility is tracked at the repository release level:

- one repository version maps to one image tag set
- mixed-version deployments are not yet part of the support promise
- the compatibility matrix is recorded in `docs/releases/compatibility-matrix.md`
