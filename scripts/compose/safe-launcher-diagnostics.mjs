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
  const requestIds = new Set();
  const responseStatusCodes = new Set();
  for (const line of logText.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
      if (
        entry.req?.method === 'POST' &&
        entry.req.url === '/internal/v1/mock-executions' &&
        typeof entry.reqId === 'string'
      ) {
        requestIds.add(entry.reqId);
      }
      if (
        typeof entry.reqId === 'string' &&
        requestIds.has(entry.reqId) &&
        [200, 409, 503].includes(entry.res?.statusCode)
      ) {
        responseStatusCodes.add(entry.res.statusCode);
      }
      if (
        entry.msg === 'Mock sandbox execution failed.' &&
        safeSandboxErrorCodes.has(entry.sandboxErrorCode)
      ) {
        codes.add(entry.sandboxErrorCode);
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
