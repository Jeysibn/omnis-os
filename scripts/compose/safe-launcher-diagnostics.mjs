const safeSandboxErrorCodes = new Set([
  'timed_out',
  'cancelled',
  'unavailable',
  'crashed',
  'output_limit',
  'launch_failed',
  'termination_failed',
]);

export function safeLauncherFailureSignals(logText) {
  const activeRequests = new Map();
  const ambiguousRequestIds = new Set();
  const completedRequests = new Map();
  const seenRequestIds = new Set();
  for (const line of logText.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      const requestId = safeRequestIdKey(entry.reqId);
      if (entry.msg === 'incoming request' && requestId) {
        if (seenRequestIds.has(requestId)) {
          activeRequests.delete(requestId);
          completedRequests.delete(requestId);
          ambiguousRequestIds.add(requestId);
        } else {
          seenRequestIds.add(requestId);
          if (entry.req?.method === 'POST' && entry.req.url === '/internal/v1/mock-executions') {
            activeRequests.set(requestId, new Set());
          }
        }
      }
      if (
        entry.msg === 'Mock sandbox execution failed.' &&
        requestId &&
        activeRequests.has(requestId) &&
        safeSandboxErrorCodes.has(entry.sandboxErrorCode)
      ) {
        activeRequests.get(requestId).add(entry.sandboxErrorCode);
      }
      if (
        entry.msg === 'request completed' &&
        requestId &&
        !ambiguousRequestIds.has(requestId) &&
        [200, 409, 503].includes(entry.res?.statusCode)
      ) {
        const requestCodes = activeRequests.get(requestId);
        if (requestCodes) {
          completedRequests.set(requestId, {
            failureCodes: requestCodes,
            responseStatusCode: entry.res.statusCode,
          });
          activeRequests.delete(requestId);
        }
      }
    } catch {
      // Ignore non-JSON output and never copy it into diagnostics.
    }
  }
  const codes = new Set();
  const responseStatusCodes = new Set();
  for (const [requestId, signals] of completedRequests) {
    if (ambiguousRequestIds.has(requestId)) continue;
    for (const code of signals.failureCodes) codes.add(code);
    responseStatusCodes.add(signals.responseStatusCode);
  }
  return {
    failureCodes: [...codes].sort(),
    responseStatusCodes: [...responseStatusCodes].sort((left, right) => left - right),
  };
}

function safeRequestIdKey(requestId) {
  if (typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128) {
    return `string:${requestId}`;
  }
  if (typeof requestId === 'number' && Number.isSafeInteger(requestId)) {
    return `number:${requestId}`;
  }
  return undefined;
}
