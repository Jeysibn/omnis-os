const safeSandboxErrorCodes = new Set([
  'timed_out',
  'cancelled',
  'unavailable',
  'crashed',
  'output_limit',
  'launch_failed',
  'termination_failed',
]);

export function safeLauncherFailureCodes(logText) {
  const codes = new Set();
  for (const line of logText.split(/\r?\n/)) {
    try {
      const entry = JSON.parse(line);
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
  return [...codes].sort();
}
