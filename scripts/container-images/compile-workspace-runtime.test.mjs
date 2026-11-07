import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileWorkspaceRuntime } from './compile-workspace-runtime.mjs';

test('deployment compilation preserves transitive and subpath imports without native type stripping', () => {
  const root = mkdtempSync(join(tmpdir(), 'omnis-runtime-compile-'));
  const write = (path, content) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    write(
      'package.json',
      JSON.stringify({ type: 'module', dependencies: { '@omnis/first': '*' } }),
    );
    write(
      'node_modules/@omnis/first/package.json',
      JSON.stringify({
        name: '@omnis/first',
        type: 'module',
        exports: { '.': './src/index.ts', './value': './src/value.ts' },
        dependencies: { '@omnis/second': '*' },
      }),
    );
    write('node_modules/@omnis/first/src/index.ts', "export { value } from './value.ts';");
    write(
      'node_modules/@omnis/first/src/value.ts',
      "import { base } from '@omnis/second'; export const value: number = base + 1;",
    );
    write(
      'node_modules/@omnis/second/package.json',
      JSON.stringify({ name: '@omnis/second', type: 'module', exports: { '.': './src/index.ts' } }),
    );
    write('node_modules/@omnis/second/src/index.ts', 'export const base: number = 41;');
    const sourceManifest = join(root, 'original-first.json');
    const deployedManifest = join(root, 'node_modules/@omnis/first/package.json');
    linkSync(deployedManifest, sourceManifest);
    const original = readFileSync(sourceManifest, 'utf8');
    assert.deepEqual(compileWorkspaceRuntime(root).sort(), ['@omnis/first', '@omnis/second']);
    assert.equal(readFileSync(sourceManifest, 'utf8'), original);
    const manifest = JSON.parse(readFileSync(join(root, 'node_modules/@omnis/first/package.json')));
    assert.equal(manifest.exports['./value'], './src/value.js');
    const output = execFileSync(
      process.execPath,
      [
        '--no-experimental-strip-types',
        '--input-type=module',
        '-e',
        "import {value} from '@omnis/first'; import {value as subpath} from '@omnis/first/value'; if(value!==42 || subpath!==42) throw new Error('incorrect runtime value'); console.log(value);",
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.equal(output.trim(), '42');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
