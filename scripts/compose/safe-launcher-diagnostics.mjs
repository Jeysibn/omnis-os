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
  const codes = new Set();
  const responseStatusCodes = new Set();
  const activeRequests = new Map();
  const ambiguousRequestIds = new Set();
  for (const line of logText.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      const requestId = typeof entry.reqId === 'string' ? entry.reqId : undefined;
      if (entry.msg === 'incoming request' && requestId) {
        if (activeRequests.has(requestId) || ambiguousRequestIds.has(requestId)) {
          activeRequests.delete(requestId);
          ambiguousRequestIds.add(requestId);
        } else if (
          entry.req?.method === 'POST' &&
          entry.req.url === '/internal/v1/mock-executions'
        ) {
          activeRequests.set(requestId, new Set());
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
        [200, 409, 503].includes(entry.res?.statusCode)
      ) {
        if (ambiguousRequestIds.has(requestId)) {
          ambiguousRequestIds.delete(requestId);
        } else {
          const requestCodes = activeRequests.get(requestId);
          if (requestCodes) {
            responseStatusCodes.add(entry.res.statusCode);
            for (const code of requestCodes) codes.add(code);
            activeRequests.delete(requestId);
          }
        }
      }
    } catch {
      // Ignore non-JSON output and never copy it into diagnostics.
    }
  }
  return {
    failureCodes: [...codes].sort(),
    responseStatusCodes: [...responseStatusCodes].sort((left, right) => left - right),
  };
}
