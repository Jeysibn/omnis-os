import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { verifyArtifactRoots, verifyProjectProgram } from '../../ci/verify-stage2a-exclusion.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'omnis-stage2a-exclusion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'app.ts');
  writeFileSync(app, '');
  const file = (relative) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '');
    return target;
  };
  const sources = new Map();
  const unresolved = new Set();
  const resolutions = new Map();
  let paths = {};
  const ts = {
    SyntaxKind: { ImportKeyword: 'import' },
    sys: { readFile: () => '{"files":["app.ts"]}' },
    readConfigFile: () => ({ config: { files: ['app.ts'] } }),
    parseJsonConfigFileContent: () => ({
      fileNames: [app],
      options: { paths },
      errors: [],
    }),
    flattenDiagnosticMessageText: (message) => String(message),
    createProgram: () => ({
      getSourceFile: (name) => sources.get(path.resolve(name)),
      getSourceFiles: () => [...sources.values()],
    }),
    isImportDeclaration: (node) => node.type === 'import',
    isExportDeclaration: (node) => node.type === 'export',
    isImportEqualsDeclaration: (node) => node.type === 'import-equals',
    isExternalModuleReference: (node) => node.type === 'external',
    isStringLiteralLike: (node) => node.type === 'string',
    isCallExpression: (node) => node.type === 'call',
    isIdentifier: (node) => node.type === 'identifier',
    forEachChild: (node, visit) => node.children?.forEach(visit),
    resolveModuleName: (specifier, from) => {
      if (unresolved.has(specifier)) return {};
      return {
        resolvedModule: {
          resolvedFileName:
            resolutions.get(specifier) ?? path.resolve(path.dirname(from), specifier),
        },
      };
    },
  };
  const source = (filename, children = []) =>
    sources.set(path.resolve(filename), { fileName: filename, children });
  return {
    root,
    app,
    file,
    source,
    ts,
    unresolved,
    resolutions,
    setPaths: (value) => {
      paths = value;
    },
  };
}

const string = (text) => ({ type: 'string', text });
const importNode = (text) => ({ type: 'import', moduleSpecifier: string(text) });
const exportNode = (text) => ({ type: 'export', moduleSpecifier: string(text) });
const dynamicNode = (text) => ({
  type: 'call',
  expression: { kind: 'import' },
  arguments: [string(text)],
});

for (const [name, nodeFactory] of [
  ['static import', importNode],
  ['re-export', exportNode],
  ['literal dynamic import', dynamicNode],
]) {
  test(`production graph rejects a direct ${name}`, (t) => {
    const f = fixture(t);
    const forbidden = f.file('scripts/mission9d/stage2a-simulated/payload.ts');
    f.source(f.app, [nodeFactory('./scripts/mission9d/stage2a-simulated/payload.ts')]);
    assert.throws(
      () => verifyProjectProgram(f.ts, path.join(f.root, 'tsconfig.json')),
      /prohibited Stage 2A dependency/,
    );
    assert.ok(forbidden);
  });
}

test('production graph rejects a prohibited indirect dependency', (t) => {
  const f = fixture(t);
  const intermediary = f.file('src/intermediary.ts');
  f.file('scripts/mission9d/stage2a-simulated/payload.ts');
  f.source(f.app, [importNode('./src/intermediary.ts')]);
  f.source(intermediary, [exportNode('../scripts/mission9d/stage2a-simulated/payload.ts')]);
  assert.throws(
    () => verifyProjectProgram(f.ts, path.join(f.root, 'tsconfig.json')),
    /prohibited Stage 2A dependency/,
  );
});

test('unresolved internal aliases, workspace packages and bare modules fail closed', (t) => {
  const f = fixture(t);
  f.source(f.app, [importNode('@internal/missing')]);
  f.unresolved.add('@internal/missing');
  f.setPaths({ '@internal/*': ['src/*'] });
  assert.throws(
    () => verifyProjectProgram(f.ts, path.join(f.root, 'tsconfig.json')),
    /unresolved TypeScript path alias/,
  );

  f.setPaths({});
  f.unresolved.clear();
  f.unresolved.add('@omnis/contracts');
  f.source(f.app, [importNode('@omnis/contracts')]);
  assert.throws(
    () => verifyProjectProgram(f.ts, path.join(f.root, 'tsconfig.json')),
    /unresolved workspace dependency/,
  );

  f.unresolved.clear();
  f.unresolved.add('@vendor/missing');
  f.source(f.app, [importNode('@vendor/missing')]);
  assert.throws(
    () => verifyProjectProgram(f.ts, path.join(f.root, 'tsconfig.json')),
    /unresolved bare dependency/,
  );
});

test('resolved external dependencies are recognized and not traversed as workspace source', (t) => {
  const f = fixture(t);
  f.source(f.app, [importNode('@vendor/library')]);
  const external = f.file('node_modules/@vendor/library/index.d.ts');
  f.resolutions.set('@vendor/library', external);
  assert.doesNotThrow(() => verifyProjectProgram(f.ts, path.join(f.root, 'tsconfig.json')));
});

test('real TypeScript resolution catches path aliases and indirect synthetic imports', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'omnis-stage2a-typescript-graph-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const synthetic = path.join(root, 'scripts/mission9d/stage2a-simulated/payload.ts');
  const intermediary = path.join(root, 'src/intermediary.ts');
  const app = path.join(root, 'src/app.ts');
  mkdirSync(path.dirname(synthetic), { recursive: true });
  mkdirSync(path.dirname(app), { recursive: true });
  writeFileSync(synthetic, 'export const syntheticPayload = true;\n');
  writeFileSync(
    intermediary,
    "export { syntheticPayload } from '../scripts/mission9d/stage2a-simulated/payload.js';\n",
  );
  writeFileSync(
    app,
    "import { syntheticPayload } from './intermediary.js'; void syntheticPayload;\n",
  );
  const config = path.join(root, 'tsconfig.json');
  writeFileSync(
    config,
    JSON.stringify({
      files: ['src/app.ts', 'src/intermediary.ts'],
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        allowImportingTsExtensions: true,
        paths: { '@synthetic/*': ['scripts/mission9d/stage2a-simulated/*'] },
      },
    }),
  );
  const importedTypeScript = await import('typescript');
  const ts = importedTypeScript.default ?? importedTypeScript;
  assert.throws(() => verifyProjectProgram(ts, config), /prohibited Stage 2A dependency/);

  writeFileSync(
    app,
    "import { syntheticPayload } from '@synthetic/payload'; void syntheticPayload;\n",
  );
  writeFileSync(
    config,
    JSON.stringify({
      files: ['src/app.ts'],
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        allowImportingTsExtensions: true,
        paths: { '@synthetic/*': ['scripts/mission9d/stage2a-simulated/*'] },
      },
    }),
  );
  assert.throws(() => verifyProjectProgram(ts, config), /prohibited Stage 2A dependency/);

  writeFileSync(app, "void import('../scripts/mission9d/stage2a-simulated/payload.js');\n");
  writeFileSync(
    config,
    JSON.stringify({
      files: ['src/app.ts'],
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        allowImportingTsExtensions: true,
      },
    }),
  );
  assert.throws(() => verifyProjectProgram(ts, config), /prohibited Stage 2A dependency/);
});

test('real TypeScript resolution rejects a missing internal path alias', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'omnis-stage2a-missing-alias-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'src/app.ts');
  mkdirSync(path.dirname(app), { recursive: true });
  writeFileSync(app, "import { missing } from '@internal/missing'; void missing;\n");
  const config = path.join(root, 'tsconfig.json');
  writeFileSync(
    config,
    JSON.stringify({
      files: ['src/app.ts'],
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        types: [],
        paths: { '@internal/*': ['src/internal/*'] },
      },
    }),
  );
  const importedTypeScript = await import('typescript');
  const ts = importedTypeScript.default ?? importedTypeScript;
  assert.throws(() => verifyProjectProgram(ts, config), /unresolved TypeScript path alias/);
});

test('clean graph and artifact pass, but missing artifact evidence fails closed', (t) => {
  const f = fixture(t);
  f.source(f.app);
  assert.doesNotThrow(() => verifyProjectProgram(f.ts, path.join(f.root, 'tsconfig.json')));
  const artifact = f.file('out/app.js');
  assert.equal(verifyArtifactRoots([path.dirname(artifact)]), 2);
  assert.throws(
    () => verifyArtifactRoots([path.join(f.root, 'missing')]),
    /artifact evidence missing/,
  );
  assert.throws(
    () =>
      verifyProjectProgram(
        { ...f.ts, parseJsonConfigFileContent: () => ({ fileNames: [], options: {}, errors: [] }) },
        path.join(f.root, 'empty.json'),
      ),
    /no source roots/,
  );
});

test('artifact check rejects a staged synthetic module path', (t) => {
  const f = fixture(t);
  const artifact = f.file('out/scripts/mission9d/stage2a-simulated/module.js');
  assert.throws(
    () => verifyArtifactRoots([path.join(f.root, 'out')]),
    /prohibited synthetic artifact/,
  );
  assert.ok(artifact);
});
