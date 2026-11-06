import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import ts from 'typescript';

// Run only on pnpm's disposable deployment output, never the source workspace.
export function compileWorkspaceRuntime(deployment) {
  const packages = new Map();
  const visit = (directory) => {
    const manifestPath = join(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const require = createRequire(manifestPath);
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (!name.startsWith('@omnis/') || packages.has(name)) continue;
      const dependencyManifest = findManifest(dirname(realpathSync(require.resolve(name))));
      if (JSON.parse(readFileSync(dependencyManifest, 'utf8')).name !== name) {
        throw new Error('Resolved workspace dependency has an unexpected identity.');
      }
      const location = dirname(dependencyManifest);
      packages.set(name, location);
      visit(location);
    }
  };
  visit(resolve(deployment));
  for (const directory of packages.values()) {
    const compile = (source) => {
      for (const entry of readdirSync(source, { withFileTypes: true })) {
        const path = join(source, entry.name);
        if (entry.isDirectory()) compile(path);
        else if (entry.name.endsWith('.ts')) {
          if (!/\.(test|spec)\.ts$/.test(entry.name)) {
            const result = ts.transpileModule(readFileSync(path, 'utf8'), {
              compilerOptions: {
                target: ts.ScriptTarget.ES2024,
                module: ts.ModuleKind.ESNext,
                verbatimModuleSyntax: true,
                rewriteRelativeImportExtensions: true,
              },
              fileName: path,
              reportDiagnostics: true,
            });
            if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error)) {
              throw new Error('Workspace runtime compilation failed.');
            }
            writeFileSync(path.replace(/\.ts$/, '.js'), result.outputText);
          }
          unlinkSync(path);
        }
      }
    };
    compile(join(directory, 'src'));
    const manifestPath = join(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const rewrite = (value) => {
      if (typeof value === 'string') return value.replace(/\.ts$/, '.js');
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
      }
      return value;
    };
    manifest.exports = rewrite(manifest.exports);
    // Break pnpm deployment hardlinks instead of modifying workspace/store manifests.
    const temporaryManifest = manifestPath + '.omnis-runtime';
    writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2) + '\n');
    renameSync(temporaryManifest, manifestPath);
  }
  return [...packages.keys()];
}

function findManifest(start) {
  let directory = start;
  for (;;) {
    try {
      readFileSync(join(directory, 'package.json'));
      return join(directory, 'package.json');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error('Workspace dependency manifest is missing.', { cause: error });
      directory = parent;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('A disposable deployment directory is required.');
  compileWorkspaceRuntime(process.argv[2]);
}
