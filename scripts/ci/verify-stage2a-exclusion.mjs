import { lstatSync, realpathSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prohibitedSegments = new Set(['stage2a-simulated']);
const staticAssetExtensions = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.webm',
]);

function isProhibited(filePath) {
  const normalized = path.resolve(filePath).split(path.sep);
  return normalized.some((segment) => prohibitedSegments.has(segment));
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function containsNodeModules(filePath) {
  return path.resolve(filePath).split(path.sep).includes('node_modules');
}

function pathAliasMatches(specifier, paths) {
  for (const alias of Object.keys(paths ?? {})) {
    const star = alias.indexOf('*');
    if (star < 0) {
      if (specifier === alias) return true;
      continue;
    }
    const prefix = alias.slice(0, star);
    const suffix = alias.slice(star + 1);
    if (
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix) &&
      specifier.length >= prefix.length + suffix.length
    )
      return true;
  }
  return false;
}

function workspacePackageNames() {
  const names = new Set();
  for (const root of ['apps', 'packages']) {
    const directory = path.join(repositoryRoot, root);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(directory, entry.name, 'package.json'), 'utf8'),
        );
        if (typeof manifest.name === 'string') names.add(manifest.name);
      } catch {
        // A workspace without a readable manifest is not a declared package.
      }
    }
  }
  return names;
}

const knownWorkspacePackages = workspacePackageNames();

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function verifyExistingStaticAsset(specifier, importer) {
  if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) return false;
  const pathname = specifier.split(/[?#]/, 1)[0];
  if (!staticAssetExtensions.has(path.extname(pathname).toLowerCase())) return false;
  const target = path.resolve(path.dirname(importer), pathname);
  let real;
  try {
    real = realpathSync.native(target);
    if (!statSync(real).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`missing production asset ${specifier} imported from ${importer}`);
  }
  if (isProhibited(real))
    throw new Error(`prohibited Stage 2A asset dependency ${specifier} -> ${real}`);
  return true;
}

function moduleSpecifiers(ts, sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const commonJsRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (dynamicImport || commonJsRequire) {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteralLike(argument)) {
          throw new Error(
            `unresolvable ${dynamicImport ? 'dynamic import' : 'require'} in ${sourceFile.fileName}`,
          );
        }
        specifiers.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

export function verifyProjectProgram(ts, projectPath) {
  const absoluteProject = path.resolve(projectPath);
  const config = ts.readConfigFile(absoluteProject, ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(absoluteProject),
  );
  if (parsed.errors.length) {
    throw new Error(
      parsed.errors
        .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'))
        .join('\n'),
    );
  }
  if (parsed.fileNames.length === 0)
    throw new Error(`production project has no source roots: ${absoluteProject}`);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const sourceFiles = new Map();
  for (const sourceFile of program.getSourceFiles()) {
    const real = realpathSync.native(sourceFile.fileName);
    sourceFiles.set(real, sourceFile);
  }
  const roots = parsed.fileNames.map((name) => realpathSync.native(path.resolve(name)));
  if (roots.some((root) => !sourceFiles.has(root)))
    throw new Error(`production source graph is incomplete: ${absoluteProject}`);
  const queue = roots.map((file) => ({ file, chain: [file] }));
  const visited = new Set();
  const failures = [];

  while (queue.length) {
    const current = queue.shift();
    const currentPath = current.file;
    if (visited.has(currentPath)) continue;
    visited.add(currentPath);
    if (isProhibited(currentPath)) {
      failures.push(`${current.chain.join(' -> ')} -> prohibited synthetic module`);
      continue;
    }
    const sourceFile = sourceFiles.get(currentPath);
    if (!sourceFile) throw new Error(`production dependency evidence missing for ${currentPath}`);
    for (const specifier of moduleSpecifiers(ts, sourceFile)) {
      if (specifier.startsWith('node:')) continue;
      const resolution = ts.resolveModuleName(
        specifier,
        currentPath,
        parsed.options,
        ts.sys,
      ).resolvedModule;
      if (!resolution) {
        if (verifyExistingStaticAsset(specifier, currentPath)) continue;
        if (specifier.startsWith('.') || path.isAbsolute(specifier))
          throw new Error(
            `unable to resolve production dependency ${specifier} from ${currentPath}`,
          );
        if (specifier.startsWith('#'))
          throw new Error(`unresolved internal package alias ${specifier} from ${currentPath}`);
        if (pathAliasMatches(specifier, parsed.options.paths))
          throw new Error(`unresolved TypeScript path alias ${specifier} from ${currentPath}`);
        const packageName = packageNameFromSpecifier(specifier);
        if (knownWorkspacePackages.has(packageName))
          throw new Error(`unresolved workspace dependency ${specifier} from ${currentPath}`);
        throw new Error(
          `unresolved bare dependency ${specifier} from ${currentPath}; all build dependencies must resolve`,
        );
      }
      const resolved = path.resolve(resolution.resolvedFileName);
      const real = realpathSync.native(resolved);
      if (isProhibited(real)) {
        failures.push(`${current.chain.join(' -> ')} -> ${specifier} -> ${real}`);
      } else if (
        !containsNodeModules(real) &&
        (isWithin(real, repositoryRoot) || isWithin(real, path.dirname(absoluteProject)))
      ) {
        queue.push({
          file: real,
          chain: [...current.chain, `${currentPath} imports ${specifier}`],
        });
      }
    }
  }

  if (failures.length) {
    throw new Error(
      `prohibited Stage 2A dependency in ${absoluteProject}:\n${failures.join('\n')}`,
    );
  }
  return { project: absoluteProject, sourceRoots: roots.length, visited: visited.size };
}

export function verifyArtifactRoots(roots) {
  if (!roots.length) throw new Error('production artifact evidence is required');
  const visited = [];
  const visit = (entry) => {
    let stat;
    try {
      stat = lstatSync(entry);
    } catch {
      throw new Error(`production artifact evidence missing: ${entry}`);
    }
    const resolved = stat.isSymbolicLink() ? realpathSync.native(entry) : entry;
    if (isProhibited(resolved))
      throw new Error(`prohibited synthetic artifact: ${entry} -> ${resolved}`);
    visited.push(resolved);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of readdirSync(entry)) visit(path.join(entry, name));
    }
  };
  for (const root of roots) visit(path.resolve(root));
  return visited.length;
}

function parseArguments(args) {
  const projects = [];
  const artifacts = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (!value || !['--project', '--artifact'].includes(option))
      throw new Error(
        'usage: verify-stage2a-exclusion.mjs --project tsconfig.json [--project ...] [--artifact path ...]',
      );
    (option === '--project' ? projects : artifacts).push(path.resolve(process.cwd(), value));
    index += 1;
  }
  if (!projects.length) throw new Error('at least one production TypeScript project is required');
  return { projects, artifacts };
}

async function main() {
  const { projects, artifacts } = parseArguments(process.argv.slice(2));
  let ts;
  try {
    ts = await import('typescript');
  } catch {
    throw new Error('TypeScript compiler API unavailable; production exclusion cannot be verified');
  }
  const compiler = ts.default ?? ts;
  for (const project of projects) {
    const result = verifyProjectProgram(compiler, project);
    process.stdout.write(
      `Stage 2A exclusion passed: ${result.project} (${result.visited} resolved project modules)\n`,
    );
  }
  if (artifacts.length) {
    const count = verifyArtifactRoots(artifacts);
    process.stdout.write(`Stage 2A artifact exclusion passed: ${count} artifact entries\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'production exclusion failed'}\n`,
    );
    process.exitCode = 1;
  });
}
