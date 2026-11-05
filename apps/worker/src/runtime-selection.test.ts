import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const productionWorker = await readFile(new URL('./server.ts', import.meta.url), 'utf8');

describe('production runtime selection boundary', () => {
  it('keeps worker startup hard-wired to the sandboxed mock adapter', () => {
    assert.match(
      productionWorker,
      /const runtime = new SandboxedMockRuntimeAdapter\(new UnixMockSandboxLauncherClient\(launcherSocket\)\)/,
    );
    assert.doesNotMatch(productionWorker, /FakeCodexAppServerRuntimeAdapter/);
    assert.doesNotMatch(
      productionWorker,
      /process\.env\.OMNIS_(?:RUNTIME_KIND|CONNECTOR_KIND|CODEX_CONNECTOR_ENABLED)/,
    );
  });
});
