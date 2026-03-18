# @delexec/contracts

`@delexec/contracts` is the pre-split protocol package for this monorepo.

It is the publishable upstream artifact that client-side and platform-side implementations are expected to consume before this monorepo is physically split into separate protocol, client, and platform repositories.

## Public API Surface

Stable protocol exports in this package:

- `REQUEST_STATUS`
- `ERROR_DOMAIN`
- `ERROR_REGISTRY`
- `getErrorDomain(code)`
- `isKnownErrorCode(code)`
- `isRetryableErrorCode(code, fallback?)`
- `buildStructuredError(code, message, options?)`
- `canonicalizeResultPackageForSignature(result)`
- `getBundledTemplatesRoot()`
- `getBundledProtocolDocsRoot()`
- `hasBundledProtocolAssets()`
- `loadBundledTemplateManifest()`
- `resolveBundledTemplatePath(relativePath?)`
- `resolveBundledProtocolDocPath(relativePath?)`

Protocol-facing stability commitments:

- error codes and their default retryability semantics are treated as protocol surface
- request lifecycle states are treated as protocol surface
- result-package canonicalization for signing is treated as protocol surface
- template packaging format is treated as protocol surface

## Packaged Assets

When packed or published, this package includes:

- `templates/`
- `templates/manifest.json`
- `protocol-docs/`

The source of truth remains the repository documentation and template directories. The package bundles a release-shaped snapshot so downstream client/platform code can consume protocol assets through a published artifact instead of a monorepo-relative path.

## Current Scope

This package intentionally excludes implementation-side runtime code:

- buyer runtime and controllers
- seller runtime and controllers
- platform API and consoles
- transport relay implementation
- storage adapters
- ops CLI and local supervisor logic

That boundary is part of the pre-split contract and is enforced by CI checks in this repository.
