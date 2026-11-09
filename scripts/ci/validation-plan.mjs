import { appendFileSync, readFileSync } from 'node:fs';

const prefix = (path, value) => path.startsWith(value);
const any = (paths, predicate) => paths.some(predicate);

export function getValidationMode({ eventName, event = {}, ref = '' }) {
  if (eventName === 'pull_request') {
    if (typeof event.pull_request?.draft !== 'boolean') {
      throw new Error('pull_request event is missing a boolean pull_request.draft value');
    }
    return event.pull_request.draft ? 'fast' : 'full';
  }

  if (eventName === 'workflow_dispatch') {
    if (ref === 'refs/heads/main' || ref === 'refs/heads/security/post-audit-remediation') {
      return 'full';
    }
    const request = event.inputs?.full_validation;
    if (request === true || request === 'true') return 'full';
    if (request === false || request === 'false' || request === undefined || request === '') {
      return 'fast';
    }
    throw new Error('workflow_dispatch full_validation input must be true or false');
  }

  if (eventName === 'push') {
    if (ref === 'refs/heads/main' || ref === 'refs/heads/security/post-audit-remediation') {
      return 'full';
    }
    throw new Error(`push event is not configured for full validation: ${ref || '(missing ref)'}`);
  }

  throw new Error(
    `unsupported CI event; refusing to select a reduced validation mode: ${eventName}`,
  );
}

export function classifyChangedFiles(paths) {
  const containerSensitive = any(
    paths,
    (path) =>
      prefix(path, '.github/workflows/') ||
      prefix(path, 'infra/docker/') ||
      prefix(path, 'infra/compose/') ||
      prefix(path, 'scripts/compose/') ||
      prefix(path, 'scripts/container-boundary/') ||
      prefix(path, 'scripts/platform/') ||
      prefix(path, 'apps/api/') ||
      prefix(path, 'apps/authorizer/') ||
      prefix(path, 'apps/sandbox-launcher/') ||
      prefix(path, 'apps/synthetic-broker/') ||
      prefix(path, 'apps/worker/') ||
      prefix(path, 'packages/contracts/') ||
      prefix(path, 'packages/policy/'),
  );

  const databaseSensitive = any(
    paths,
    (path) => prefix(path, 'packages/db/') || prefix(path, 'scripts/db-recovery/'),
  );

  const backendSensitive = any(
    paths,
    (path) =>
      prefix(path, 'apps/api/') ||
      prefix(path, 'apps/authorizer/') ||
      prefix(path, 'apps/sandbox-launcher/') ||
      prefix(path, 'apps/synthetic-broker/') ||
      prefix(path, 'apps/worker/') ||
      prefix(path, 'packages/contracts/') ||
      prefix(path, 'packages/policy/'),
  );

  const securitySensitive =
    containerSensitive ||
    databaseSensitive ||
    backendSensitive ||
    any(paths, (path) => prefix(path, 'scripts/host-security/'));

  const fullStackSensitive =
    databaseSensitive ||
    backendSensitive ||
    any(paths, (path) => path === 'apps/web/server.ts' || path === 'apps/web/src/ui/api.ts');

  return { securitySensitive, containerSensitive, databaseSensitive, fullStackSensitive };
}

export function selectDraftBrowserSpecs(paths) {
  const specs = new Set(['src/ui/shell.spec.ts']);
  let unclassifiedUiChange = false;

  for (const path of paths) {
    if (!path.startsWith('apps/web/src/ui/')) continue;

    const filename = path.slice('apps/web/'.length);
    if (filename.endsWith('.spec.ts')) {
      specs.add(filename);
    } else if (/command-center/i.test(filename)) {
      specs.add('src/ui/command-center.spec.ts');
      specs.add('src/ui/command-center-order.spec.ts');
    } else if (/projects?/i.test(filename)) {
      specs.add('src/ui/projects.spec.ts');
      specs.add('src/ui/projects.recovery.spec.ts');
    } else if (/runstream|run-event/i.test(filename)) {
      specs.add('src/ui/runStreamSession.spec.ts');
    } else if (/agents?/i.test(filename)) {
      specs.add('src/ui/agents.spec.ts');
    } else if (/departments?/i.test(filename)) {
      specs.add('src/ui/departments.spec.ts');
    } else {
      unclassifiedUiChange = true;
    }
  }

  if (unclassifiedUiChange) {
    for (const spec of [
      'src/ui/agents.spec.ts',
      'src/ui/command-center-order.spec.ts',
      'src/ui/command-center.spec.ts',
      'src/ui/departments.spec.ts',
      'src/ui/design.spec.ts',
      'src/ui/projects.recovery.spec.ts',
      'src/ui/projects.spec.ts',
      'src/ui/runStreamSession.spec.ts',
      'src/ui/shell.spec.ts',
    ]) {
      specs.add(spec);
    }
  }

  return [...specs].sort();
}

export function getGateFailures({ mode, results = {}, sensitive = {} }) {
  const failures = [];
  const required = ['validation_mode', 'checks_core', 'frontend_browser'];

  if (mode === 'full') {
    required.push(
      'platform_security',
      'database_integration',
      'full_stack_browser_integration',
      'backup_restore',
      'container_images',
    );
  } else if (mode === 'fast') {
    if (sensitive.security_sensitive) required.push('platform_security');
    if (sensitive.container_sensitive) required.push('container_images');
    if (sensitive.database_sensitive) required.push('database_integration', 'backup_restore');
    if (sensitive.full_stack_sensitive) required.push('full_stack_browser_integration');
  } else {
    failures.push('validation mode is missing or invalid');
  }

  for (const name of required) {
    const result = results[name];
    if (result !== 'success') failures.push(`${name}=${result || 'missing'}`);
  }

  if (mode === 'fast') {
    failures.push('full_validation_deferred=fast mode cannot satisfy the required merge gate');
  }

  return failures;
}

function readEvent() {
  if (!process.env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required');
  return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
}

function main() {
  const event = readEvent();
  const paths = (process.env.OMNIS_CHANGED_FILES ?? '')
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean);
  const mode = getValidationMode({
    eventName: process.env.GITHUB_EVENT_NAME,
    event,
    ref: process.env.GITHUB_REF,
  });
  const changePlan = classifyChangedFiles(paths);
  const browserSpecs = selectDraftBrowserSpecs(paths);
  const output = {
    mode,
    full: mode === 'full',
    ...changePlan,
    browserSpecs: JSON.stringify(browserSpecs),
  };

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(output)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
    );
  }

  process.stdout.write(`CI validation mode: ${mode}\n`);
  process.stdout.write(
    `Sensitive change groups: ${
      Object.entries(changePlan)
        .filter(([, value]) => value)
        .map(([key]) => key)
        .join(', ') || 'none'
    }\n`,
  );
  process.stdout.write(`Draft browser specs selected: ${browserSpecs.join(', ')}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
