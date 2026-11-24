const PUBLIC_CODES = new Set(('invalid_model_selection model_config_missing provider_not_found provider_not_configured model_not_found invalid_model_request invalid_model_response model_request_failed model_request_auth_missing model_request_cancelled model_request_timeout model_rate_limited model_context_exceeded model_error model_timeout configuration_error permission_denied permission_timeout tool_execution_failed turn_cancelled cancelled unknown_error insufficient_quota rate_limit_exceeded invalid_api_key').split(' '));
const PUBLIC_REASONS = new Set(['rate_limited', 'auth_failed', 'invalid_request', 'context_exceeded', 'server_error', 'network_error', 'timeout', 'stream_idle_timeout', 'provider_overloaded', 'provider_not_configured', 'stale_connection', 'auth_refresh', 'offpeak_queued', 'reasoning_signature_repair', 'cancelled', 'tls_error', 'proxy_error', 'unknown']);
export const ERROR_RESULTS = new Set(['error_max_turns', 'error_max_budget', 'error_during_execution', 'error_max_tool_calls']);

function publicCode(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && (/^-?\d{1,8}$/.test(value) || PUBLIC_CODES.has(value.toLowerCase()))) return value;
}

function failureDetails(error) {
  const attribution = error?.attribution ?? error?.data?.attribution ?? {};
  const providerCode = publicCode(attribution.providerErrorCode ?? error?.providerCode ?? error?.providerErrorCode
    ?? error?.data?.providerCode ?? error?.data?.providerErrorCode);
  // Older bundles retain the business code only in the error description.
  const messageCode = typeof error?.message === 'string' ? /\b(?:code|limit)\s*[:=]?\s*["']?(\d{3,8})\b/i.exec(error.message)?.[1] : undefined;
  const reason = attribution.reason ?? error?.reason ?? error?.data?.reason;
  return {
    errorCode: publicCode(error?.code),
    errorType: publicCode(error?.type),
    businessCode: providerCode ?? messageCode,
    status: attribution.statusCode ?? error?.statusCode ?? error?.data?.statusCode,
    reason: PUBLIC_REASONS.has(reason) ? reason : undefined,
  };
}

// Only public diagnostic fields cross into terminal output. The provider's
// message and response body can contain headers or credentials.
function diagnostic({ errorCode, errorType, businessCode, status, reason }) {
  const code = errorCode ?? errorType;
  return [code && `code=${code}`, businessCode && `provider_code=${businessCode}`,
    Number.isInteger(status) && status >= 100 && status <= 599 && `HTTP ${status}`,
    businessCode === '1308' ? 'reason=usage limit' : reason && `reason=${reason.replaceAll('_', ' ')}`].filter(Boolean).join('; ');
}

export function safeErrorSummary(error) {
  return diagnostic(failureDetails(error));
}

export function classifyFailure(error, resultType) {
  const details = failureDetails(error);
  const { businessCode, errorCode, errorType, status, reason } = details;
  const hasCode = (...codes) => codes.includes(errorCode?.toLowerCase()) || codes.includes(errorType?.toLowerCase());
  let kind;
  if (businessCode === '1308' || hasCode('insufficient_quota')) kind = 'quota';
  else if (businessCode === '1302' || status === 429 || reason === 'rate_limited' || hasCode('model_rate_limited', 'rate_limit_exceeded')) kind = 'rate_limit';
  else if (status === 401 || reason === 'auth_failed' || hasCode('invalid_api_key', 'model_request_auth_missing')) kind = 'auth';
  else if (hasCode('permission_denied', 'permission_timeout')) kind = 'permission';
  return { state: kind ? 'blocked' : 'error', kind, diagnostic: diagnostic(details),
    reason: reason ?? (ERROR_RESULTS.has(resultType) ? resultType : undefined) };
}
