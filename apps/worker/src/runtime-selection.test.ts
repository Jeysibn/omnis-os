import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const productionWorker = await readFile(new URL('./server.ts', import.meta.url), 'utf8');

describe('production runtime selection boundary', () => {
  it('constructs the launcher only for explicit mock mode and fences restarted jobs', () => {
    assert.match(
      productionWorker,
      /const launcherClient =\s*executionMode === 'mock' \? new UnixMockSandboxLauncherClient\(launcherSocket!\) : undefined;\s*const runtime = launcherClient \? new SandboxedMockRuntimeAdapter\(launcherClient\) : undefined;/,
    );
    assert.match(
      productionWorker,
      /executionModeFromEnvironment\(process\.env\.OMNIS_EXECUTION_MODE\)/,
    );
    assert.match(productionWorker, /executionMode === 'mock'[\s\S]*?new PgBoss\(/);
    assert.match(productionWorker, /requireSessionFence: true/);
    assert.match(productionWorker, /startExecutionQueue\(executionMode/);
    assert.doesNotMatch(productionWorker, /reconcileDisabledExecution/);
    assert.doesNotMatch(productionWorker, /FakeCodexAppServerRuntimeAdapter/);
    assert.doesNotMatch(
      productionWorker,
      /process\.env\.OMNIS_(?:RUNTIME_KIND|CONNECTOR_KIND|CODEX_CONNECTOR_ENABLED)/,
    );
    assert.doesNotMatch(productionWorker, /connector-authorization|ConnectorAuthorization/);
    assert.doesNotMatch(productionWorker, /\.consume\(/);
  });
});
