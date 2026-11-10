import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createProvenanceProbe } from './wsl2-provenance-probe.mjs';

test('synthetic probe records kernel socket tuple, never claimed forwarding headers', async () => {
  const records = [];
  const server = createProvenanceProbe((value) => records.push(value));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await globalThis.fetch(`${base}/probe/windows-v4`, {
      headers: {
        Host: 'forged.invalid',
        Origin: 'https://localhost:8443',
        'X-Forwarded-For': 'secret-fixture',
        Cookie: 'secret-fixture',
      },
    });
    assert.equal(result.status, 200);
    assert.match(await result.text(), /synthetic path diagnostic/);
    assert.equal(records.length, 1);
    assert.equal(records[0].remoteAddress, '127.0.0.1');
    assert.equal(records[0].synthetic, true);
    assert.equal(records[0].caseId, 'windows-v4');
    assert.ok(!JSON.stringify(records).includes('secret-fixture'));
    for (const path of ['/probe/../secret-fixture', '/probe/a?secret-fixture', '/']) {
      assert.equal((await globalThis.fetch(`${base}${path}`)).status, 400);
    }
    assert.equal(
      (await globalThis.fetch(`${base}/probe/a`, { method: 'POST', body: 'secret-fixture' }))
        .status,
      400,
    );
    assert.equal(records.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
