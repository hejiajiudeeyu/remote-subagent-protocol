import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const BUNDLED_TEMPLATES_ROOT = path.join(PACKAGE_ROOT, 'templates');
const BUNDLED_PROTOCOL_DOCS_ROOT = path.join(PACKAGE_ROOT, 'protocol-docs');
const BUNDLED_TEMPLATE_MANIFEST_PATH = path.join(BUNDLED_TEMPLATES_ROOT, 'manifest.json');

export const REQUEST_STATUS = {
  CREATED: 'CREATED',
  SENT: 'SENT',
  ACKED: 'ACKED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  UNVERIFIED: 'UNVERIFIED',
  TIMED_OUT: 'TIMED_OUT'
};

export const ERROR_DOMAIN = {
  AUTH: 'AUTH',
  CONTRACT: 'CONTRACT',
  EXEC: 'EXEC',
  RESULT: 'RESULT',
  DELIVERY: 'DELIVERY',
  TEMPLATE: 'TEMPLATE',
  PLATFORM: 'PLATFORM',
  CATALOG: 'CATALOG',
  REQUEST: 'REQUEST',
  SELLER: 'SELLER',
  USER: 'USER',
  SUBAGENT: 'SUBAGENT',
  EXECUTOR: 'EXECUTOR',
  TRANSPORT: 'TRANSPORT',
  SIGNER: 'SIGNER',
  TASK: 'TASK',
  BUYER: 'BUYER',
  RELAY: 'RELAY',
  OPS: 'OPS'
};

export const ERROR_REGISTRY = Object.freeze({
  AUTH_UNAUTHORIZED: { retryable: false },
  AUTH_SCOPE_FORBIDDEN: { retryable: false },
  AUTH_RESOURCE_FORBIDDEN: { retryable: false },
  AUTH_TOKEN_INVALID: { retryable: true },
  AUTH_TOKEN_EXPIRED: { retryable: false },
  AUTH_INTROSPECT_FAILED: { retryable: true },
  AUTH_TOKEN_NOT_FOUND: { retryable: false },
  AUTH_AUDIENCE_MISMATCH: { retryable: false },
  AUTH_CREDENTIALS_MISSING: { retryable: false },
  AUTH_INVALID_CREDENTIALS: { retryable: false },
  AUTH_INVALID_PASSPHRASE: { retryable: false },
  AUTH_SECRET_STORE_EXISTS: { retryable: false },
  AUTH_SECRET_STORE_MISSING: { retryable: false },
  AUTH_SESSION_REQUIRED: { retryable: false },
  AUTH_BOOTSTRAP_FORBIDDEN: { retryable: false },
  AUTH_KEY_NOT_FOUND: { retryable: false },

  CONTRACT_INVALID_JSON: { retryable: false },
  CONTRACT_INVALID_REGISTER_BODY: { retryable: false },
  CONTRACT_INVALID_SELLER_REGISTER_BODY: { retryable: false },
  CONTRACT_INVALID_RESULT_DELIVERY: { retryable: false },
  CONTRACT_INVALID_TOKEN_REQUEST: { retryable: false },
  CONTRACT_INVALID_DELIVERY_META_REQUEST: { retryable: false },
  CONTRACT_INVALID_ACK_REQUEST: { retryable: false },
  CONTRACT_INVALID_REQUEST_EVENT: { retryable: false },
  CONTRACT_INVALID_METRIC_EVENT: { retryable: false },
  CONTRACT_INVALID_ROLE_GRANT: { retryable: false },
  CONTRACT_INVALID_API_KEY_REVOKE: { retryable: false },
  CONTRACT_INVALID_PREPARE_REQUEST: { retryable: false },
  CONTRACT_INVALID_REMOTE_REQUEST: { retryable: false },
  CONTRACT_INVALID_POLL_REQUEST: { retryable: false },
  CONTRACT_INVALID_PEEK_REQUEST: { retryable: false },
  CONTRACT_INVALID_SEND_REQUEST: { retryable: false },
  CONTRACT_INVALID_BATCH_REQUEST: { retryable: false },
  CONTRACT_INVALID_SIGNING_KEY_ROTATION: { retryable: false },
  CONTRACT_INVALID_TIMEOUT: { retryable: false },
  CONTRACT_TIMEOUT_EXCEEDS_SELLER_LIMIT: { retryable: false },
  CONTRACT_TASK_TYPE_UNSUPPORTED: { retryable: false },
  CONTRACT_REJECTED: { retryable: false },
  CONTRACT_UNSUPPORTED_VERSION: { retryable: false },
  CONTRACT_INVALID_TRANSPORT_BODY: { retryable: false },
  CONTRACT_INVALID_TRANSPORT_TYPE: { retryable: false },

  EXEC_TIMEOUT: { retryable: true },
  EXEC_TIMEOUT_HARD: { retryable: false },
  EXEC_TIMEOUT_MANUAL_STOP: { retryable: false },
  EXEC_INTERNAL_ERROR: { retryable: true },
  EXEC_UNKNOWN: { retryable: true },
  EXECUTOR_RUNTIME_ERROR: { retryable: false },
  EXECUTOR_INVALID_RESULT: { retryable: false },
  EXEC_IN_PROGRESS: { retryable: true },
  EXEC_QUEUE_FULL: { retryable: true },

  RESULT_CONTEXT_MISMATCH: { retryable: false },
  RESULT_SIGNATURE_INVALID: { retryable: false },
  RESULT_SCHEMA_INVALID: { retryable: false },
  RESULT_ARTIFACT_INVALID: { retryable: false },
  RESULT_BODY_INVALID_JSON: { retryable: false },
  RESULT_ARTIFACT_TOO_LARGE: { retryable: false },
  RESULT_DELIVERY_KIND_NOT_IMPLEMENTED: { retryable: false },
  RESULT_NOT_READY: { retryable: true },

  DELIVERY_OR_ACCEPTANCE_TIMEOUT: { retryable: true },
  DELIVERY_FAILED: { retryable: true },
  DELIVERY_DUPLICATE: { retryable: false },
  DELIVERY_PARSE_FAILED: { retryable: false },
  DELIVERY_RATE_LIMITED: { retryable: true },

  TEMPLATE_NOT_FOUND: { retryable: false },
  TEMPLATE_REF_MISMATCH: { retryable: false },

  PLATFORM_NOT_CONFIGURED: { retryable: false },
  PLATFORM_RATE_LIMITED: { retryable: true },
  PLATFORM_API_INTERNAL_ERROR: { retryable: true },
  PLATFORM_REVIEW_TRANSPORT_NOT_CONFIGURED: { retryable: false },
  PLATFORM_REVIEW_TEST_UNSUPPORTED: { retryable: false },

  CATALOG_SUBAGENT_NOT_FOUND: { retryable: false },

  REQUEST_NOT_FOUND: { retryable: false },
  REQUEST_BINDING_MISMATCH: { retryable: false },
  REQUEST_ALREADY_TERMINAL: { retryable: false },

  SELLER_NOT_FOUND: { retryable: false },
  SELLER_NOT_APPROVED: { retryable: false },
  SELLER_NOT_ENABLED: { retryable: false },
  SELLER_PLATFORM_REGISTER_FAILED: { retryable: true },
  SELLER_RUNTIME_INTERNAL_ERROR: { retryable: true },

  USER_NOT_FOUND: { retryable: false },

  SUBAGENT_ID_ALREADY_EXISTS: { retryable: false },
  SUBAGENT_QUOTA_EXCEEDED: { retryable: false },
  SUBAGENT_NOT_APPROVED: { retryable: false },
  SUBAGENT_INVALID_RESULT: { retryable: false },
  SUBAGENT_PROCESS_EXITED: { retryable: false },
  SUBAGENT_PROCESS_INVALID_JSON: { retryable: false },
  SUBAGENT_HTTP_INVALID_JSON: { retryable: false },
  SUBAGENT_HTTP_FAILED: { retryable: false },
  SUBAGENT_NOT_CONFIGURED: { retryable: false },
  SUBAGENT_ID_REQUIRED: { retryable: false },
  SUBAGENT_INVALID_INPUT: { retryable: false },
  SUBAGENT_NOT_FOUND: { retryable: false },

  TRANSPORT_NOT_CONFIGURED: { retryable: false },
  TRANSPORT_SEND_NOT_AVAILABLE: { retryable: false },
  TRANSPORT_POLL_NOT_AVAILABLE: { retryable: false },
  TRANSPORT_CONNECTION_FAILED: { retryable: true },

  SIGNER_BINDING_MISMATCH: { retryable: false },

  TASK_NOT_FOUND: { retryable: false },

  BUYER_PLATFORM_REGISTER_FAILED: { retryable: true },
  BUYER_PLATFORM_CATALOG_FAILED: { retryable: true },
  BUYER_PLATFORM_SELLER_REGISTER_FAILED: { retryable: true },
  BUYER_PLATFORM_TOKEN_FAILED: { retryable: true },
  BUYER_PLATFORM_DELIVERY_META_FAILED: { retryable: true },
  BUYER_PLATFORM_EVENTS_FAILED: { retryable: true },
  BUYER_PLATFORM_EVENTS_BATCH_FAILED: { retryable: true },
  BUYER_PLATFORM_METRIC_FAILED: { retryable: true },
  BUYER_PLATFORM_PREPARE_FAILED: { retryable: true },
  BUYER_REMOTE_REQUEST_FAILED: { retryable: true },
  BUYER_CONTROLLER_INTERNAL_ERROR: { retryable: true },
  BUYER_NOT_REGISTERED: { retryable: false },

  RELAY_INTERNAL_ERROR: { retryable: true },

  OPS_SUPERVISOR_INTERNAL_ERROR: { retryable: true }
});

export function getErrorDomain(code = '') {
  return String(code).split('_', 1)[0] || null;
}

export function isKnownErrorCode(code) {
  return Object.prototype.hasOwnProperty.call(ERROR_REGISTRY, code);
}

export function isRetryableErrorCode(code, fallback = false) {
  return isKnownErrorCode(code) ? ERROR_REGISTRY[code].retryable === true : fallback;
}

export function buildStructuredError(code, message, options = {}) {
  const { retryable, ...extra } = options;
  return {
    error: {
      code,
      message,
      retryable: retryable ?? isRetryableErrorCode(code, false)
    },
    ...extra
  };
}

export function canonicalizeResultPackageForSignature(result = {}) {
  const canonical = {};

  for (const key of [
    'message_type',
    'request_id',
    'result_version',
    'seller_id',
    'subagent_id',
    'verification',
    'status',
    'output',
    'artifacts',
    'error',
    'timing',
    'usage'
  ]) {
    if (key in result) {
      canonical[key] = result[key];
    }
  }

  return canonical;
}

export function getBundledTemplatesRoot() {
  return BUNDLED_TEMPLATES_ROOT;
}

export function getBundledProtocolDocsRoot() {
  return BUNDLED_PROTOCOL_DOCS_ROOT;
}

export function hasBundledProtocolAssets() {
  return fs.existsSync(BUNDLED_TEMPLATE_MANIFEST_PATH);
}

export function loadBundledTemplateManifest() {
  if (!hasBundledProtocolAssets()) {
    throw new Error('contracts_bundled_assets_missing');
  }
  return JSON.parse(fs.readFileSync(BUNDLED_TEMPLATE_MANIFEST_PATH, 'utf8'));
}

export function resolveBundledTemplatePath(relativePath = '') {
  return path.join(BUNDLED_TEMPLATES_ROOT, relativePath);
}

export function resolveBundledProtocolDocPath(relativePath = '') {
  return path.join(BUNDLED_PROTOCOL_DOCS_ROOT, relativePath);
}
