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
  PLATFORM: 'PLATFORM'
};

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
