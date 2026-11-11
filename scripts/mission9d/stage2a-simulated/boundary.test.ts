import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = join(directory, '../../..');

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const child = join(path, entry.name);
      if (entry.isDirectory()) return filesUnder(child);
      return [child];
    }),
  );
  return nested.flat();
}

test('synthetic implementation remains isolated from production import and registration paths', async () => {
  const productionRoots = [
    join(repository, 'apps'),
    join(repository, 'packages'),
    join(repository, 'scripts'),
    join(repository, 'infra'),
  ];
  const exclusionGuards = new Set([
    join(repository, 'scripts/ci/verify-stage2a-exclusion.mjs'),
    join(repository, 'scripts/ci/verify-stage2a-artifact.mjs'),
  ]);
  for (const root of productionRoots) {
    for (const file of await filesUnder(root)) {
      if (file.startsWith(directory)) continue;
      if (exclusionGuards.has(file)) {
        const source = await readFile(file, 'utf8');
        assert.doesNotMatch(
          source,
          /(?:from\s*|import\s*\()\s*['"][^'"]*stage2a-simulated/i,
          relative(repository, file),
        );
        continue;
      }
      if (!/\.(?:[cm]?[jt]s|json|yml|yaml)$/.test(file)) continue;
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(
        source,
        /(?:from\s*|import\s*\()\s*['"][^'"]*stage2a-simulated/i,
        relative(repository, file),
      );
      assert.doesNotMatch(
        source,
        /(?:from\s*|import\s*\()\s*['"][^'"]*SimulatedLedgerStore/i,
        relative(repository, file),
      );
    }
  }
  const manifests = [join(repository, 'package.json')];
  for (const file of manifests) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /stage2a-simulated/i, relative(repository, file));
  }
});

test('synthetic source has no network, process-launch, Docker or systemd adapter', async () => {
  for (const file of await filesUnder(directory)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /from ['"]node:(?:net|http|https|child_process)['"]/);
    assert.doesNotMatch(source, /\b(?:docker|systemd|createServer|listen|spawn|execFile)\b/i);
    for (const match of source.matchAll(/from ['"](\.{1,2}\/[^'"]+)['"]/g)) {
      assert.equal(match[1]?.startsWith('../'), false, relative(directory, file));
    }
  }
});
