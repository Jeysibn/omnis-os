import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageScript = path.join(repoRoot, 'scripts/host-security/package-application-tree.sh');
const deploymentScript = path.join(
  repoRoot,
  'scripts/host-security/verify-disposable-systemd-deployment.sh',
);
const workflowPath = path.join(repoRoot, '.github/workflows/ci.yml');

test('deployment packaging includes tracked app files and excludes nested secrets and keys', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'omnis-package-policy-'));
  const source = path.join(root, 'source');
  const stage = path.join(root, 'stage');
  mkdirSync(source);
  mkdirSync(stage);
  try {
    execFileSync('git', ['init', '-q', source]);
    const fixtures = [
      'apps/api/src/index.ts',
      'apps/api/.env',
      'apps/api/.env.local',
      'packages/nested/.env.production',
      'config/credentials.json',
      'keys/service.pem',
      'keys/id_ed25519',
      'config/private.key',
      'node_modules/.pnpm/demo/node_modules/demo/index.js',
      'node_modules/.pnpm/demo/node_modules/demo/.env.local',
      'apps/api/node_modules/demo-credential/credential.json',
      'docs/allowed.md',
    ];
    for (const file of fixtures) {
      const target = path.join(source, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `fixture: ${file}`);
    }
    execFileSync('git', ['-C', source, 'add', '.']);
    execFileSync('git', [
      '-C',
      source,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixtures',
    ]);

    execFileSync('bash', [packageScript, source, stage]);
    assert.equal(
      readFileSync(path.join(stage, 'apps/api/src/index.ts'), 'utf8'),
      'fixture: apps/api/src/index.ts',
    );
    assert.equal(
      readFileSync(path.join(stage, 'node_modules/.pnpm/demo/node_modules/demo/index.js'), 'utf8'),
      'fixture: node_modules/.pnpm/demo/node_modules/demo/index.js',
    );
    assert.equal(
      readFileSync(path.join(stage, 'docs/allowed.md'), 'utf8'),
      'fixture: docs/allowed.md',
    );
    for (const file of fixtures.filter((entry) =>
      /\.env|credential|\.pem$|\.key$|id_ed25519/.test(entry),
    )) {
      assert.equal(pathExists(path.join(stage, file)), false, `${file} entered deployment tree`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('systemd deployment preflight refuses before registering cleanup and CI cannot skip required checks', () => {
  const script = readFileSync(deploymentScript, 'utf8');
  const envPreflight = script.indexOf(
    'if [[ -e "$repo_root/$env_file" || -L "$repo_root/$env_file" ]]',
  );
  const cleanupTrap = script.indexOf('trap cleanup EXIT');
  assert.notEqual(envPreflight, -1, 'pre-existing env files must be checked');
  assert.ok(
    cleanupTrap > envPreflight,
    'cleanup must not be armed before the pre-existing env-file check',
  );
  assert.match(script, /created_envs=\(\)/);
  assert.match(script, /created_units=\(\)/);
  assert.match(script, /tac "\$resource_manifest"/);
  assert.match(script, /created_application_tree\)\); then rm -rf -- \/opt\/omnis-os/);
  assert.doesNotMatch(script, /rm -rf -- \/opt\/omnis-os \/etc\/omnis/);
  assert.match(script, /RUNNER_ENVIRONMENT:-\}" != github-hosted/);
  assert.match(script, /Systemd preflight diagnostics: pid1_comm=/);
  assert.match(script, /init_pid_namespace=%s current_pid_namespace=%s/);
  assert.match(script, /container_marker=%s runner_os=%s runner_environment=%s/);
  assert.match(script, /Required CI verification unavailable: a running systemd PID 1 is required/);
  assert.match(
    script,
    /Required CI verification unavailable: Docker must be an active systemd service/,
  );
  assert.doesNotMatch(script, /SKIP:/);
  assert.match(script, /CI_REQUIRED_SYSTEMD_E2E_VERIFICATION_PASSED/);
  assert.match(readFileSync(workflowPath, 'utf8'), /OMNIS_SYSTEMD_VERIFICATION_REQUIRED: 'true'/);

  const result = spawnSync('bash', [deploymentScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CI: 'true',
      OMNIS_HOST_ISOLATION_TEST: 'true',
      OMNIS_SYSTEMD_VERIFICATION_REQUIRED: 'true',
    },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, 'a non-GitHub-hosted invocation must fail closed');
  assert.match(result.stderr, /Refusing host provisioning/);
});

test('agent idempotency signing key is generated into the authorizer-only service environment', () => {
  const installer = readFileSync(
    path.join(repoRoot, 'scripts/host-security/install-service-secrets.sh'),
    'utf8',
  );
  const configuration = readFileSync(path.join(repoRoot, 'scripts/configure-owner.ts'), 'utf8');
  const template = readFileSync(path.join(repoRoot, '.env.authorizer.example'), 'utf8');
  assert.match(
    configuration,
    /OMNIS_AGENT_IDEMPOTENCY_KEY=\$\{randomBytes\(32\)\.toString\('hex'\)\}/,
  );
  assert.match(configuration, /OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION=1/);
  assert.match(template, /OMNIS_AGENT_IDEMPOTENCY_KEY=/);
  assert.match(installer, /OMNIS_AGENT_IDEMPOTENCY_KEY\(_VERSION\)\?=/);
  assert.match(installer, /OMNIS_AGENT_IDEMPOTENCY_KEY=\[0-9a-fA-F\]\{64\}/);
  const deployment = readFileSync(deploymentScript, 'utf8');
  assert.match(deployment, /agent_idempotency_key=.*-N32/);
  assert.match(deployment, /OMNIS_AGENT_IDEMPOTENCY_KEY=\$agent_idempotency_key/);
  assert.doesNotMatch(
    deployment.split('create_env_file "$repo_root/.env"')[1]?.split('EOF')[0] ?? '',
    /OMNIS_AGENT_IDEMPOTENCY_KEY=/,
  );
});

function pathExists(target) {
  try {
    readFileSync(target);
    return true;
  } catch (error) {
    if (error.code === 'EISDIR') return true;
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
