import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRestrictedEnvPair, restrictedComposeEnvironment } from './restricted-env-policy.mjs';

const directory = mkdtempSync(join(tmpdir(), 'omnis-compose-config-'));
try {
  const apiEnv = join(directory, 'api.env');
  const workerEnv = join(directory, 'worker.env');
  const restrictedApiEnv = join(directory, 'restricted-api.env');
  const restrictedWorkerEnv = join(directory, 'restricted-worker.env');
  const overrideApiEnv = join(directory, 'override-api.env');
  const overrideWorkerEnv = join(directory, 'override-worker.env');
  const composeEnv = join(directory, 'compose.env');
  const restrictedComposeEnv = join(directory, 'restricted-compose.env');
  const composeNoMockEnv = join(directory, 'compose-no-mock.env');
  const composeNoRestrictedDbEnv = join(directory, 'compose-no-restricted-db.env');
  const projectName = 'omnis-os-restricted-dev';
  writeFileSync(
    apiEnv,
    [
      `OMNIS_OWNER_PASSWORD_HASH=${'a'.repeat(32)}:${'b'.repeat(128)}`,
      `OMNIS_SESSION_SECRET=${'s'.repeat(64)}`,
      `OMNIS_INTERNAL_TOKEN=${'i'.repeat(64)}`,
      `OMNIS_API_AUTHORIZER_TOKEN=${'a'.repeat(64)}`,
      'OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock',
      `OMNIS_AUTHORIZER_DB_PASSWORD=${'z'.repeat(48)}`,
      'OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock',
      'OMNIS_RESTRICTED_DEVELOPMENT=false',
      'OMNIS_ALLOWED_ORIGIN=https://omnis.example.invalid',
      'OMNIS_SECURE_COOKIES=true',
      'OMNIS_EXECUTION_MODE=mock',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    workerEnv,
    [
      `OMNIS_INTERNAL_TOKEN=${'i'.repeat(64)}`,
      `OMNIS_RUNTIME_DB_PASSWORD=${'r'.repeat(48)}`,
      `OMNIS_API_AUTHORIZER_TOKEN=${'a'.repeat(64)}`,
      'OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock',
      `OMNIS_AUTHORIZER_DB_PASSWORD=${'z'.repeat(48)}`,
      'OMNIS_DB_NAME=omnis_restricted_dev',
      'OMNIS_EXECUTION_MODE=mock',
      'OMNIS_RESTRICTED_DEVELOPMENT=false',
      'OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock',
    ].join('\n'),
    { mode: 0o600 },
  );
  const restrictedApiEnvLines = [
    `OMNIS_OWNER_PASSWORD_HASH=${'a'.repeat(32)}:${'b'.repeat(128)}`,
    `OMNIS_SESSION_SECRET=${'c'.repeat(96)}`,
    `OMNIS_INTERNAL_TOKEN=${'d'.repeat(96)}`,
    'OMNIS_ALLOWED_ORIGIN=http://127.0.0.1:8080',
    'OMNIS_SECURE_COOKIES=false',
  ];
  const restrictedWorkerEnvLines = [
    `OMNIS_INTERNAL_TOKEN=${'d'.repeat(96)}`,
    `OMNIS_RUNTIME_DB_PASSWORD=${'e'.repeat(64)}`,
  ];
  writeFileSync(restrictedApiEnv, restrictedApiEnvLines.join('\n'), { mode: 0o600 });
  writeFileSync(restrictedWorkerEnv, restrictedWorkerEnvLines.join('\n'), { mode: 0o600 });
  writeFileSync(
    overrideApiEnv,
    [
      `OMNIS_OWNER_PASSWORD_HASH=${'f'.repeat(32)}:${'e'.repeat(128)}`,
      `OMNIS_SESSION_SECRET=${'f'.repeat(96)}`,
      `OMNIS_INTERNAL_TOKEN=${'f'.repeat(96)}`,
      'OMNIS_ALLOWED_ORIGIN=http://127.0.0.1:8081',
      'OMNIS_SECURE_COOKIES=false',
    ].join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    overrideWorkerEnv,
    [`OMNIS_INTERNAL_TOKEN=${'f'.repeat(96)}`, `OMNIS_RUNTIME_DB_PASSWORD=${'f'.repeat(64)}`].join(
      '\n',
    ),
    { mode: 0o600 },
  );
  const composeEnvLines = [
    'OMNIS_RESTRICTED_DB_NAME=omnis_restricted_dev',
    `OMNIS_DB_PASSWORD=${'d'.repeat(48)}`,
    'OMNIS_EXECUTION_MODE=mock',
    'OMNIS_MOCK_EXECUTION_MODE=mock',
    'OMNIS_WEB_PORT=18080',
    'OMNIS_AUTHORIZER_SOCKET_GID=10101',
    'OMNIS_LAUNCHER_SOCKET_GID=10102',
    `OMNIS_API_ENV_FILE=${apiEnv}`,
    `OMNIS_WORKER_ENV_FILE=${workerEnv}`,
    `OMNIS_RESTRICTED_API_ENV_FILE=${restrictedApiEnv}`,
    `OMNIS_RESTRICTED_WORKER_ENV_FILE=${restrictedWorkerEnv}`,
  ];
  writeFileSync(composeEnv, composeEnvLines.join('\n'), { mode: 0o600 });
  const restrictedComposeEnvLines = [
    'OMNIS_RESTRICTED_DB_NAME=omnis_restricted_dev',
    `OMNIS_DB_PASSWORD=${'f'.repeat(64)}`,
    'OMNIS_WEB_PORT=18080',
    `OMNIS_RESTRICTED_API_ENV_FILE=${restrictedApiEnv}`,
    `OMNIS_RESTRICTED_WORKER_ENV_FILE=${restrictedWorkerEnv}`,
  ];
  writeFileSync(restrictedComposeEnv, restrictedComposeEnvLines.join('\n'), { mode: 0o600 });
  writeFileSync(
    composeNoMockEnv,
    composeEnvLines.filter((line) => !line.startsWith('OMNIS_MOCK_EXECUTION_MODE=')).join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    composeNoRestrictedDbEnv,
    restrictedComposeEnvLines
      .filter((line) => !line.startsWith('OMNIS_RESTRICTED_DB_NAME='))
      .join('\n'),
    { mode: 0o600 },
  );
  const composeNoRestrictedApiEnv = join(directory, 'compose-no-restricted-api-env.env');
  const composeNoRestrictedWorkerEnv = join(directory, 'compose-no-restricted-worker-env.env');
  writeFileSync(
    composeNoRestrictedApiEnv,
    restrictedComposeEnvLines
      .filter((line) => !line.startsWith('OMNIS_RESTRICTED_API_ENV_FILE='))
      .join('\n'),
    { mode: 0o600 },
  );
  writeFileSync(
    composeNoRestrictedWorkerEnv,
    restrictedComposeEnvLines
      .filter((line) => !line.startsWith('OMNIS_RESTRICTED_WORKER_ENV_FILE='))
      .join('\n'),
    { mode: 0o600 },
  );
  const restrictedEnvPair = readRestrictedEnvPair(
    restrictedComposeEnv,
    restrictedApiEnv,
    restrictedWorkerEnv,
  );
  assert.equal(
    restrictedEnvPair.api.OMNIS_INTERNAL_TOKEN,
    restrictedEnvPair.worker.OMNIS_INTERNAL_TOKEN,
  );

  const validEnvCheck = spawnSync(
    process.execPath,
    [
      'scripts/compose/verify-restricted-env.mjs',
      '--compose-env',
      restrictedComposeEnv,
      '--api-env',
      restrictedApiEnv,
      '--worker-env',
      restrictedWorkerEnv,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(validEnvCheck.status, 0, 'allowlisted synthetic env files must pass preflight');
  assert.ok(!validEnvCheck.stdout.includes('d'.repeat(96)));
  assert.ok(!validEnvCheck.stderr.includes('d'.repeat(96)));
  assert.ok(!validEnvCheck.stdout.includes('f'.repeat(64)));
  assert.ok(!validEnvCheck.stderr.includes('f'.repeat(64)));

  const interpolatedApiEnvPath = join(directory, '$UNAPPROVED_ROOT', 'restricted-api.env');
  const interpolatedPathComposeEnv = join(directory, 'restricted-compose-interpolated-path.env');
  writeFileSync(
    interpolatedPathComposeEnv,
    restrictedComposeEnvLines
      .map((line) =>
        line.startsWith('OMNIS_RESTRICTED_API_ENV_FILE=')
          ? `OMNIS_RESTRICTED_API_ENV_FILE=${interpolatedApiEnvPath}`
          : line,
      )
      .join('\n'),
    { mode: 0o600 },
  );
  const interpolatedPathCheck = spawnSync(
    process.execPath,
    [
      'scripts/compose/verify-restricted-env.mjs',
      '--compose-env',
      interpolatedPathComposeEnv,
      '--api-env',
      interpolatedApiEnvPath,
      '--worker-env',
      restrictedWorkerEnv,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(interpolatedPathCheck.status, 0);
  assert.ok(interpolatedPathCheck.stderr.includes('absolute literal path without interpolation'));
  assert.ok(!interpolatedPathCheck.stderr.includes('$UNAPPROVED_ROOT'));

  const fakeDocker = join(directory, 'docker');
  const fakeDockerCapture = join(directory, 'docker-capture.json');
  const fakeContextCapture = join(directory, 'docker-context-capture.json');
  writeFileSync(
    fakeDocker,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === 'context' && args[1] === 'inspect') {",
      "  fs.writeFileSync(process.env.VERIFY_DOCKER_CONTEXT_CAPTURE_FILE, JSON.stringify({ context: args.at(-1), endpoint: process.env.VERIFY_DOCKER_ENDPOINT || 'unix:///var/run/docker.sock' }));",
      "  process.stdout.write(process.env.VERIFY_DOCKER_ENDPOINT || 'unix:///var/run/docker.sock');",
      '} else {',
      "  fs.writeFileSync(process.env.VERIFY_DOCKER_CAPTURE_FILE, JSON.stringify({ args, keys: Object.keys(process.env), contextInspection: JSON.parse(fs.readFileSync(process.env.VERIFY_DOCKER_CONTEXT_CAPTURE_FILE, 'utf8')) }));",
      '}',
    ].join('\n'),
    { mode: 0o700 },
  );
  chmodSync(fakeDocker, 0o700);
  const fakeDockerEnvironment = {
    ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    VERIFY_DOCKER_CAPTURE_FILE: fakeDockerCapture,
    VERIFY_DOCKER_CONTEXT_CAPTURE_FILE: fakeContextCapture,
    OMNIS_RESTRICTED_DB_NAME: 'omnis_wrong_project',
    OMNIS_RESTRICTED_API_ENV_FILE: overrideApiEnv,
    OMNIS_RESTRICTED_WORKER_ENV_FILE: overrideWorkerEnv,
    COMPOSE_PROJECT_NAME: 'omnis-os',
    COMPOSE_FILE: 'infra/compose/docker-compose.mock-execution.yml',
    COMPOSE_PROFILES: 'mock-execution',
  };
  const wrapperOutput = execFileSync(
    'bash',
    [
      'scripts/compose/restricted-compose.sh',
      'default',
      'unix:///var/run/docker.sock',
      restrictedComposeEnv,
      restrictedApiEnv,
      restrictedWorkerEnv,
      'config',
      '--quiet',
    ],
    { encoding: 'utf8', env: fakeDockerEnvironment },
  );
  const wrapperCapture = JSON.parse(readFileSync(fakeDockerCapture, 'utf8'));
  assert.deepEqual(wrapperCapture.contextInspection, {
    context: 'default',
    endpoint: 'unix:///var/run/docker.sock',
  });
  assert.deepEqual(wrapperCapture.args, [
    '--context',
    'default',
    'compose',
    '--project-name',
    'omnis-os-restricted-dev',
    '--env-file',
    restrictedComposeEnv,
    '-f',
    'infra/compose/docker-compose.yml',
    '-f',
    'infra/compose/docker-compose.app.yml',
    '-f',
    'infra/compose/docker-compose.restricted-dev.yml',
    'config',
    '--quiet',
  ]);
  assert.ok(!wrapperCapture.keys.some((key) => key.startsWith('OMNIS_')));
  assert.ok(!wrapperCapture.keys.some((key) => key.startsWith('COMPOSE_')));
  assert.ok(!wrapperOutput.includes('omnis_wrong_project'));
  assert.ok(!wrapperOutput.includes(overrideApiEnv));

  rmSync(fakeDockerCapture);
  const wrapperInjection = spawnSync(
    'bash',
    [
      'scripts/compose/restricted-compose.sh',
      'default',
      'unix:///var/run/docker.sock',
      restrictedComposeEnv,
      restrictedApiEnv,
      restrictedWorkerEnv,
      'config',
      '--quiet',
      '--project-name',
      'omnis-os',
    ],
    { encoding: 'utf8', env: fakeDockerEnvironment },
  );
  assert.notEqual(wrapperInjection.status, 0, 'wrapper must reject unapproved Compose flags');
  assert.equal(
    existsSync(fakeDockerCapture),
    false,
    'rejected wrapper call must not invoke Docker',
  );
  assert.ok(!wrapperInjection.stdout.includes('omnis_wrong_project'));
  assert.ok(!wrapperInjection.stderr.includes('omnis_wrong_project'));

  const wrapperContextMismatch = spawnSync(
    'bash',
    [
      'scripts/compose/restricted-compose.sh',
      'default',
      'unix:///tmp/other-docker.sock',
      restrictedComposeEnv,
      restrictedApiEnv,
      restrictedWorkerEnv,
      'config',
      '--quiet',
    ],
    { encoding: 'utf8', env: fakeDockerEnvironment },
  );
  assert.notEqual(wrapperContextMismatch.status, 0);
  assert.equal(
    existsSync(fakeDockerCapture),
    false,
    'endpoint mismatch must stop before Compose is invoked',
  );
  assert.ok(!wrapperContextMismatch.stdout.includes('omnis_wrong_project'));
  assert.ok(!wrapperContextMismatch.stderr.includes('omnis_wrong_project'));

  for (const selector of ['DOCKER_HOST', 'DOCKER_CONTEXT']) {
    const wrapperAmbiguousDockerTarget = spawnSync(
      'bash',
      [
        'scripts/compose/restricted-compose.sh',
        'default',
        'unix:///var/run/docker.sock',
        restrictedComposeEnv,
        restrictedApiEnv,
        restrictedWorkerEnv,
        'config',
        '--quiet',
      ],
      {
        encoding: 'utf8',
        env: { ...fakeDockerEnvironment, [selector]: 'remote' },
      },
    );
    assert.notEqual(wrapperAmbiguousDockerTarget.status, 0);
    assert.equal(
      existsSync(fakeDockerCapture),
      false,
      `${selector} override must stop before Compose is invoked`,
    );
  }

  const wrapperRemoteEndpoint = spawnSync(
    'bash',
    [
      'scripts/compose/restricted-compose.sh',
      'default',
      'tcp://remote.example.invalid:2375',
      restrictedComposeEnv,
      restrictedApiEnv,
      restrictedWorkerEnv,
      'config',
      '--quiet',
    ],
    { encoding: 'utf8', env: fakeDockerEnvironment },
  );
  assert.notEqual(wrapperRemoteEndpoint.status, 0);
  assert.equal(
    existsSync(fakeDockerCapture),
    false,
    'non-local Docker endpoints must stop before Compose is invoked',
  );

  for (const invalidEnvCase of [
    { service: 'api', name: 'OPENAI_API_KEY', value: 'provider-sentinel' },
    { service: 'api', name: 'ANTHROPIC_API_KEY', value: 'provider-sentinel-2' },
    { service: 'api', name: 'OMNIS_API_AUTHORIZER_TOKEN', value: 'authorizer-sentinel' },
    { service: 'worker', name: 'OMNIS_SANDBOX_LAUNCHER_SOCKET', value: '/tmp/launcher.sock' },
    { service: 'worker', name: 'OMNIS_DB_PASSWORD', value: 'admin-database-sentinel' },
    { service: 'worker', name: 'OMNIS_ADMIN_DATABASE_URL', value: 'admin-url-sentinel' },
    { service: 'worker', name: 'OMNIS_MIGRATION_DB_PASSWORD', value: 'migration-sentinel' },
    { service: 'worker', name: 'OMNIS_UNKNOWN_SETTING', value: 'unknown-sentinel' },
    { service: 'compose', name: 'ANTHROPIC_API_KEY', value: 'provider-compose-sentinel' },
    {
      service: 'compose',
      name: 'OMNIS_MIGRATION_DB_PASSWORD',
      value: 'migration-compose-sentinel',
    },
  ]) {
    const invalidApiPath = join(directory, `invalid-${invalidEnvCase.service}-api.env`);
    const invalidWorkerPath = join(directory, `invalid-${invalidEnvCase.service}-worker.env`);
    const invalidComposePath = join(directory, `invalid-${invalidEnvCase.service}-compose.env`);
    const writeInvalid = (lines, addInvalid) =>
      [...lines, ...(addInvalid ? [`${invalidEnvCase.name}=${invalidEnvCase.value}`] : [])].join(
        '\n',
      );
    writeFileSync(
      invalidApiPath,
      writeInvalid(restrictedApiEnvLines, invalidEnvCase.service === 'api'),
      { mode: 0o600 },
    );
    writeFileSync(
      invalidWorkerPath,
      writeInvalid(restrictedWorkerEnvLines, invalidEnvCase.service === 'worker'),
      { mode: 0o600 },
    );
    const invalidComposeLines = restrictedComposeEnvLines.map((line) =>
      line.startsWith('OMNIS_RESTRICTED_API_ENV_FILE=')
        ? `OMNIS_RESTRICTED_API_ENV_FILE=${invalidApiPath}`
        : line.startsWith('OMNIS_RESTRICTED_WORKER_ENV_FILE=')
          ? `OMNIS_RESTRICTED_WORKER_ENV_FILE=${invalidWorkerPath}`
          : line,
    );
    writeFileSync(
      invalidComposePath,
      writeInvalid(invalidComposeLines, invalidEnvCase.service === 'compose'),
      { mode: 0o600 },
    );
    const invalidEnvCheck = spawnSync(
      process.execPath,
      [
        'scripts/compose/verify-restricted-env.mjs',
        '--compose-env',
        invalidComposePath,
        '--api-env',
        invalidApiPath,
        '--worker-env',
        invalidWorkerPath,
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(invalidEnvCheck.status, 0, `${invalidEnvCase.name} must fail preflight`);
    assert.ok(invalidEnvCheck.stderr.includes(invalidEnvCase.name));
    assert.ok(!invalidEnvCheck.stdout.includes(invalidEnvCase.value));
    assert.ok(!invalidEnvCheck.stderr.includes(invalidEnvCase.value));
  }
  const mismatchedWorkerEnv = join(directory, 'restricted-worker-mismatched.env');
  writeFileSync(
    mismatchedWorkerEnv,
    [`OMNIS_INTERNAL_TOKEN=${'9'.repeat(96)}`, `OMNIS_RUNTIME_DB_PASSWORD=${'e'.repeat(64)}`].join(
      '\n',
    ),
    { mode: 0o600 },
  );
  const mismatchedComposeEnv = join(directory, 'restricted-compose-mismatched.env');
  writeFileSync(
    mismatchedComposeEnv,
    restrictedComposeEnvLines
      .map((line) =>
        line.startsWith('OMNIS_RESTRICTED_WORKER_ENV_FILE=')
          ? `OMNIS_RESTRICTED_WORKER_ENV_FILE=${mismatchedWorkerEnv}`
          : line,
      )
      .join('\n'),
    { mode: 0o600 },
  );
  const mismatchedTokenCheck = spawnSync(
    process.execPath,
    [
      'scripts/compose/verify-restricted-env.mjs',
      '--compose-env',
      mismatchedComposeEnv,
      '--api-env',
      restrictedApiEnv,
      '--worker-env',
      mismatchedWorkerEnv,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(mismatchedTokenCheck.status, 0);
  assert.ok(mismatchedTokenCheck.stderr.includes('same internal token'));
  assert.ok(!mismatchedTokenCheck.stderr.includes('d'.repeat(96)));
  assert.ok(!mismatchedTokenCheck.stderr.includes('9'.repeat(96)));

  const insecureApiEnv = join(directory, 'restricted-api-insecure-mode.env');
  writeFileSync(insecureApiEnv, restrictedApiEnvLines.join('\n'), { mode: 0o644 });
  chmodSync(insecureApiEnv, 0o644);
  const insecureComposeEnv = join(directory, 'restricted-compose-insecure-mode.env');
  writeFileSync(
    insecureComposeEnv,
    restrictedComposeEnvLines
      .map((line) =>
        line.startsWith('OMNIS_RESTRICTED_API_ENV_FILE=')
          ? `OMNIS_RESTRICTED_API_ENV_FILE=${insecureApiEnv}`
          : line,
      )
      .join('\n'),
    { mode: 0o600 },
  );
  const insecureFileCheck = spawnSync(
    process.execPath,
    [
      'scripts/compose/verify-restricted-env.mjs',
      '--compose-env',
      insecureComposeEnv,
      '--api-env',
      insecureApiEnv,
      '--worker-env',
      restrictedWorkerEnv,
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(insecureFileCheck.status, 0);
  assert.ok(insecureFileCheck.stderr.includes('private, regular file'));
  assert.ok(!insecureFileCheck.stderr.includes('d'.repeat(96)));
  const renderConfig = (
    extraFiles = [],
    activeProfile,
    envFile = composeEnv,
    executionModeOverride = 'mock',
    includeRestrictedOverlay = true,
    projectNameOverride = projectName,
    composeProjectNameOverride,
    ambientOverrides = {},
    sanitizeAmbientEnvironment = true,
  ) => {
    const args = ['compose'];
    if (projectNameOverride) args.push('--project-name', projectNameOverride);
    args.push(
      '--env-file',
      envFile,
      '-f',
      'infra/compose/docker-compose.yml',
      '-f',
      'infra/compose/docker-compose.app.yml',
    );
    if (includeRestrictedOverlay) {
      args.push('-f', 'infra/compose/docker-compose.restricted-dev.yml');
    }
    for (const file of extraFiles) args.push('-f', file);
    if (activeProfile) args.push('--profile', activeProfile);
    args.push('config', '--format', 'json');
    const childEnvironment = sanitizeAmbientEnvironment
      ? restrictedComposeEnvironment(process.env)
      : { ...restrictedComposeEnvironment(process.env), ...ambientOverrides };
    if (composeProjectNameOverride) {
      childEnvironment.COMPOSE_PROJECT_NAME = composeProjectNameOverride;
    }
    childEnvironment.OMNIS_EXECUTION_MODE = executionModeOverride;
    return JSON.parse(
      execFileSync('docker', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnvironment,
      }),
    );
  };
  const config = renderConfig([], undefined, restrictedComposeEnv);
  const baseEnvironment = { ...process.env };
  for (const key of Object.keys(baseEnvironment)) {
    if (key.startsWith('OMNIS_') || key.startsWith('COMPOSE_')) delete baseEnvironment[key];
  }
  const baseConfig = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        composeEnv,
        '-f',
        'infra/compose/docker-compose.yml',
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: baseEnvironment },
    ),
  );
  const configWithoutProjectFlag = renderConfig(
    [],
    undefined,
    restrictedComposeEnv,
    'mock',
    true,
    null,
  );
  const configWithWrongProjectFlag = renderConfig(
    [],
    undefined,
    restrictedComposeEnv,
    'mock',
    true,
    'omnis-os',
  );
  const configWithWrongProjectEnvironment = renderConfig(
    [],
    undefined,
    restrictedComposeEnv,
    'mock',
    true,
    null,
    'omnis-os',
  );
  const conflictingAmbientOverrides = {
    OMNIS_RESTRICTED_DB_NAME: 'omnis_wrong_project',
    OMNIS_RESTRICTED_API_ENV_FILE: overrideApiEnv,
    OMNIS_RESTRICTED_WORKER_ENV_FILE: overrideWorkerEnv,
    COMPOSE_PROJECT_NAME: 'omnis-os',
    COMPOSE_FILE: 'infra/compose/docker-compose.mock-execution.yml',
    COMPOSE_PROFILES: 'mock-execution',
  };
  const configWithAmbientOverrides = renderConfig(
    [],
    undefined,
    restrictedComposeEnv,
    'mock',
    true,
    null,
    undefined,
    conflictingAmbientOverrides,
    false,
  );
  const configWithSanitizedAmbientOverrides = renderConfig(
    [],
    undefined,
    restrictedComposeEnv,
    'mock',
    true,
    null,
    undefined,
    conflictingAmbientOverrides,
  );
  const mockConfigWithoutProjectFlag = renderConfig(
    ['infra/compose/docker-compose.mock-execution.yml'],
    'mock-execution',
    composeEnv,
    'mock',
    false,
    null,
  );
  const conflictingModeConfigs = ['enabled', 'unknown-mode', ''].map((mode) =>
    renderConfig([], undefined, restrictedComposeEnv, mode),
  );
  assert.throws(() => renderConfig([], undefined, composeNoRestrictedDbEnv));
  assert.throws(() => renderConfig([], undefined, composeNoRestrictedApiEnv));
  assert.throws(() => renderConfig([], undefined, composeNoRestrictedWorkerEnv));
  const mockUnselectedConfig = renderConfig(
    ['infra/compose/docker-compose.mock-execution.yml'],
    undefined,
    composeEnv,
    'mock',
    false,
  );
  assert.throws(() =>
    renderConfig(['infra/compose/docker-compose.mock-execution.yml'], undefined, composeNoMockEnv),
  );
  const mockConfig = renderConfig(
    ['infra/compose/docker-compose.mock-execution.yml'],
    'mock-execution',
    composeEnv,
    'mock',
    false,
  );
  const { api, postgres, web, worker } = config.services;
  assert.deepEqual(Object.keys(config.services).sort(), ['api', 'postgres', 'web', 'worker']);
  assert.equal(config.name, projectName);
  const assertRestrictedProject = (rendered) =>
    assert.equal(rendered.name, projectName, 'restricted Compose project identity is mandatory');
  assertRestrictedProject(configWithoutProjectFlag);
  assert.equal(configWithAmbientOverrides.name, 'omnis-os');
  assert.equal(
    configWithAmbientOverrides.services.postgres.environment.POSTGRES_DB,
    'omnis_wrong_project',
  );
  assert.equal(
    configWithAmbientOverrides.services.api.environment.OMNIS_ALLOWED_ORIGIN,
    'http://127.0.0.1:8081',
  );
  assert.equal(
    configWithAmbientOverrides.services.worker.environment.OMNIS_RUNTIME_DB_PASSWORD,
    'f'.repeat(64),
  );
  assertRestrictedProject(configWithSanitizedAmbientOverrides);
  assert.equal(
    configWithSanitizedAmbientOverrides.services.postgres.environment.POSTGRES_DB,
    'omnis_restricted_dev',
  );
  assert.equal(
    configWithSanitizedAmbientOverrides.services.api.environment.OMNIS_ALLOWED_ORIGIN,
    'http://127.0.0.1:8080',
  );
  assert.equal(
    configWithSanitizedAmbientOverrides.services.worker.environment.OMNIS_RUNTIME_DB_PASSWORD,
    'e'.repeat(64),
  );
  assert.throws(() => assertRestrictedProject(configWithWrongProjectFlag));
  assert.throws(() => assertRestrictedProject(configWithWrongProjectEnvironment));
  assert.equal(
    configWithWrongProjectFlag.volumes['omnis-postgres-data'].name,
    'omnis-os_omnis-postgres-data',
  );
  assert.equal(
    configWithWrongProjectEnvironment.volumes['omnis-postgres-data'].name,
    'omnis-os_omnis-postgres-data',
  );
  assert.equal(baseConfig.name, 'omnis-os');
  assert.deepEqual(Object.keys(baseConfig.services), ['postgres']);
  assert.equal(baseConfig.volumes['omnis-postgres-data'].name, 'omnis-os_omnis-postgres-data');
  assert.equal(mockConfig.name, projectName);
  assert.equal(mockConfigWithoutProjectFlag.name, 'omnis-os');
  assert.equal(
    mockConfigWithoutProjectFlag.volumes['omnis-postgres-data'].name,
    'omnis-os_omnis-postgres-data',
  );
  assert.ok(api && postgres && web && worker);
  const expectedResources = new Map([
    [api, { pids: 128, memory: '805306368', cpus: 1 }],
    [worker, { pids: 256, memory: '1073741824', cpus: 1.5 }],
    [web, { pids: 64, memory: '268435456', cpus: 0.5 }],
  ]);
  for (const [service, resources] of expectedResources) {
    assert.equal(service.read_only, true);
    assert.equal(service.privileged ?? false, false);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.deepEqual(service.cap_add ?? [], []);
    assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
    assert.equal(service.init, true);
    assert.equal(service.restart, 'unless-stopped');
    assert.equal(service.pids_limit, resources.pids);
    assert.equal(service.mem_limit, resources.memory);
    assert.equal(service.cpus, resources.cpus);
    assert.ok(service.healthcheck?.test?.length > 0);
    assert.deepEqual(service.devices ?? [], []);
    assert.deepEqual(service.device_cgroup_rules ?? [], []);
    for (const namespace of ['network_mode', 'pid', 'ipc', 'uts', 'cgroup']) {
      assert.notEqual(service[namespace], 'host', `${namespace} host namespace is forbidden`);
    }
  }
  assert.equal(api.user, '10001:10001');
  assert.equal(worker.user, '10001:10001');
  assert.equal(web.user, '10001:10001');
  assert.equal(postgres.user ?? undefined, undefined);
  assert.equal(postgres.read_only ?? false, false);
  assert.deepEqual(postgres.cap_drop ?? [], []);
  assert.deepEqual(postgres.security_opt ?? [], []);
  assert.equal(postgres.pids_limit, undefined);
  assert.equal(postgres.mem_limit, undefined);
  assert.equal(postgres.cpus, undefined);
  assert.match(postgres.image, /^postgres:17\.6-alpine@sha256:[a-f0-9]{64}$/);
  assert.equal(postgres.environment.POSTGRES_USER, 'omnis');
  assert.equal(postgres.environment.POSTGRES_PASSWORD, 'f'.repeat(64));
  assert.deepEqual(api.group_add ?? [], []);
  assert.deepEqual(worker.group_add ?? [], []);
  assert.deepEqual(web.group_add ?? [], []);
  assert.deepEqual(postgres.group_add ?? [], []);
  assert.equal(api.stop_grace_period, '30s');
  assert.equal(worker.stop_grace_period, '30s');
  assert.equal(web.stop_grace_period, '5s');
  assert.deepEqual(api.tmpfs, ['/tmp:rw,noexec,nosuid,size=16m']);
  assert.deepEqual(worker.tmpfs, ['/tmp:rw,noexec,nosuid,size=32m']);
  assert.deepEqual(web.tmpfs ?? [], []);
  assert.deepEqual(postgres.tmpfs ?? [], []);
  assert.deepEqual(api.ports ?? [], []);
  assert.deepEqual(worker.ports ?? [], []);
  assert.equal(api.environment.OMNIS_EXECUTION_MODE, 'disabled');
  assert.equal(worker.environment.OMNIS_EXECUTION_MODE, 'disabled');
  assert.equal(api.environment.OMNIS_RESTRICTED_DEVELOPMENT, 'true');
  assert.equal(worker.environment.OMNIS_RESTRICTED_DEVELOPMENT, 'true');
  assert.equal(api.environment.OMNIS_EXECUTION_MODE, worker.environment.OMNIS_EXECUTION_MODE);
  assert.equal(api.environment.OMNIS_SANDBOX_LAUNCHER_SOCKET, '');
  assert.equal(worker.environment.OMNIS_SANDBOX_LAUNCHER_SOCKET, '');
  for (const service of [api, worker]) {
    for (const forbidden of [
      'OMNIS_API_AUTHORIZER_TOKEN',
      'OMNIS_AUTHORIZER_SOCKET',
      'OMNIS_AUTHORIZER_DB_PASSWORD',
      'OMNIS_AUTHORIZER_DATABASE_URL',
      'OMNIS_AGENT_IDEMPOTENCY_KEY',
      'OMNIS_CONNECTOR_DECISION_KEY_FILE',
      'OMNIS_BROKER_AUTHORIZER_TOKEN',
      'OMNIS_SANDBOX_LAUNCHER_SOCKET',
      'OMNIS_LAUNCHER_DATABASE_URL',
      'OMNIS_LAUNCHER_DB_PASSWORD',
    ]) {
      assert.equal(service.environment[forbidden], '', `${forbidden} must be cleared`);
    }
  }
  assert.equal(api.environment.OMNIS_API_HOST, '0.0.0.0');
  assert.equal(api.environment.OMNIS_WORKER_HOST, 'worker');
  assert.equal(worker.environment.OMNIS_WORKER_HOST, '0.0.0.0');
  assert.equal(worker.environment.OMNIS_DB_HOST, 'postgres');
  assert.equal(worker.environment.OMNIS_DB_NAME, 'omnis_restricted_dev');
  assert.equal(worker.environment.OMNIS_DATABASE_URL, '');
  assert.equal(worker.environment.OMNIS_DB_PORT, '5432');
  assert.equal(postgres.environment.POSTGRES_DB, 'omnis_restricted_dev');
  assert.match(postgres.environment.POSTGRES_DB, /^omnis_[a-z0-9_]+$/);
  assert.notEqual(postgres.environment.POSTGRES_DB, 'omnis');
  assert.equal(web.environment.OMNIS_API_URL, 'http://api:4100');
  assert.equal(api.environment.OMNIS_SECURE_COOKIES, 'false');
  assert.equal(api.environment.OMNIS_ALLOWED_ORIGIN, 'http://127.0.0.1:8080');
  assert.equal(api.environment.OMNIS_API_AUTHORIZER_TOKEN, '');
  assert.equal(api.environment.OMNIS_OWNER_PASSWORD_HASH, `${'a'.repeat(32)}:${'b'.repeat(128)}`);
  assert.equal(api.environment.OMNIS_SESSION_SECRET, 'c'.repeat(96));
  assert.equal(api.environment.OMNIS_INTERNAL_TOKEN, worker.environment.OMNIS_INTERNAL_TOKEN);
  assert.equal(worker.environment.OMNIS_RUNTIME_DB_PASSWORD, 'e'.repeat(64));
  assert.equal(worker.environment.OMNIS_API_AUTHORIZER_TOKEN, '');
  assert.equal(worker.environment.OMNIS_AUTHORIZER_DB_PASSWORD, '');
  assert.ok(!Object.hasOwn(api.environment, 'OMNIS_RUNTIME_DB_PASSWORD'));
  for (const service of [api, worker]) {
    for (const denied of [
      'OMNIS_DB_PASSWORD',
      'POSTGRES_PASSWORD',
      'OMNIS_MIGRATION_DB_PASSWORD',
      'OMNIS_ADMIN_DATABASE_URL',
      'OMNIS_MIGRATION_DATABASE_URL',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GOOGLE_API_KEY',
    ]) {
      assert.ok(
        !Object.hasOwn(service.environment, denied),
        `${denied} must not reach application services`,
      );
    }
  }
  for (const conflictingConfig of conflictingModeConfigs) {
    assert.equal(conflictingConfig.services.api.environment.OMNIS_EXECUTION_MODE, 'disabled');
    assert.equal(conflictingConfig.services.worker.environment.OMNIS_EXECUTION_MODE, 'disabled');
    assert.equal(conflictingConfig.services.api.environment.OMNIS_RESTRICTED_DEVELOPMENT, 'true');
    assert.equal(
      conflictingConfig.services.worker.environment.OMNIS_RESTRICTED_DEVELOPMENT,
      'true',
    );
  }
  for (const service of Object.values(config.services)) {
    for (const providerCredential of [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
    ]) {
      assert.ok(
        !Object.hasOwn(service.environment ?? {}, providerCredential),
        `${providerCredential} must not be required by the restricted Compose configuration`,
      );
    }
  }
  assert.equal(web.ports[0].host_ip, '127.0.0.1');
  assert.equal(web.ports[0].published, '18080');
  assert.equal(postgres.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.networks.edge.internal, true);
  assert.equal(config.networks.data.internal, true);
  assert.ok(Object.hasOwn(api.networks, 'edge') && Object.hasOwn(api.networks, 'data'));
  assert.ok(Object.hasOwn(worker.networks, 'data') && !Object.hasOwn(worker.networks, 'edge'));
  assert.ok(Object.hasOwn(web.networks, 'edge') && !Object.hasOwn(web.networks, 'data'));
  assert.ok(Object.hasOwn(postgres.networks, 'data'));
  assert.deepEqual(api.volumes ?? [], []);
  assert.deepEqual(worker.volumes ?? [], []);
  assert.deepEqual(web.volumes ?? [], []);
  assert.equal(postgres.volumes.length, 1);
  assert.equal(postgres.volumes[0].source, 'omnis-postgres-data');
  assert.equal(postgres.volumes[0].target, '/var/lib/postgresql/data');
  assert.equal(config.volumes['omnis-postgres-data'].name, `${projectName}_omnis-postgres-data`);
  assert.notEqual(config.volumes['omnis-postgres-data'].external, true);
  assert.equal(config.networks.edge.name, `${projectName}_edge`);
  assert.equal(config.networks.data.name, `${projectName}_data`);
  assert.notEqual(config.networks.edge.external, true);
  assert.notEqual(config.networks.data.external, true);
  assert.ok(
    Object.values(config.services).every((service) => service.container_name === undefined),
  );
  assert.ok(JSON.stringify(api.healthcheck.test).includes('/api/v1/health'));
  assert.ok(!JSON.stringify(api.healthcheck.test).includes('/runtime-capabilities'));
  assert.ok(JSON.stringify(worker.healthcheck.test).includes('/internal/v1/health'));
  assert.ok(!JSON.stringify(worker.healthcheck.test).includes('/runtime-capabilities'));

  const composeSource = readFileSync('infra/compose/docker-compose.app.yml', 'utf8');
  assert.equal((composeSource.match(/create_host_path:\s*false/g) ?? []).length, 1);
  assert.ok(!JSON.stringify(config).includes('/run/omnis-sandbox'));
  assert.ok(!JSON.stringify(config).includes('/var/run/docker.sock'));
  assert.ok(!JSON.stringify(config).includes('/run/docker.sock'));
  assert.deepEqual(Object.keys(mockUnselectedConfig.services ?? {}), []);

  const mockServices = mockConfig.services;
  for (const service of Object.values(mockServices)) {
    assert.deepEqual(service.profiles, ['mock-execution']);
  }
  for (const service of Object.values(config.services)) {
    assert.equal(service.profiles, undefined);
  }
  assert.equal(mockServices.api.environment.OMNIS_EXECUTION_MODE, 'mock');
  assert.equal(mockServices.worker.environment.OMNIS_EXECUTION_MODE, 'mock');
  assert.equal(
    mockServices.worker.environment.OMNIS_SANDBOX_LAUNCHER_SOCKET,
    '/run/omnis-sandbox/launcher.sock',
  );
  assert.equal(mockServices.api.volumes.length, 1);
  assert.equal(mockServices.api.volumes[0].source, '/run/omnis-authorizer');
  assert.equal(mockServices.api.volumes[0].target, '/run/omnis-authorizer');
  assert.deepEqual(mockServices.api.group_add, ['10101']);
  assert.equal(mockServices.worker.volumes.length, 1);
  assert.equal(mockServices.worker.volumes[0].type, 'bind');
  assert.equal(mockServices.worker.volumes[0].source, '/run/omnis-sandbox');
  assert.equal(mockServices.worker.volumes[0].target, '/run/omnis-sandbox');
  assert.equal(mockServices.worker.volumes[0].read_only, true);
  assert.deepEqual(mockServices.worker.group_add, ['10102']);

  for (const rendered of [config, mockConfig]) {
    assert.deepEqual(Object.keys(rendered.services).sort(), ['api', 'postgres', 'web', 'worker']);
    for (const service of Object.values(rendered.services)) {
      assert.equal(service.privileged ?? false, false);
      assert.deepEqual(service.cap_add ?? [], []);
      assert.deepEqual(service.devices ?? [], []);
      assert.deepEqual(service.device_cgroup_rules ?? [], []);
      for (const port of service.ports ?? []) assert.equal(port.host_ip, '127.0.0.1');
      for (const namespace of ['network_mode', 'pid', 'ipc', 'uts', 'cgroup']) {
        assert.notEqual(service[namespace], 'host', `${namespace} host namespace is forbidden`);
      }
    }
    assert.deepEqual(
      Object.entries(rendered.services)
        .filter(([, service]) => (service.ports ?? []).length > 0)
        .map(([name]) => name)
        .sort(),
      ['postgres', 'web'],
    );
    assert.equal(rendered.services.web.ports[0].target, 8080);
    assert.equal(rendered.services.postgres.ports[0].target, 5432);
    assert.equal(rendered.services.web.ports[0].published, '18080');
    assert.equal(rendered.services.postgres.ports[0].published, '5432');
    assert.deepEqual(Object.keys(rendered.volumes).sort(), ['omnis-postgres-data']);
    assert.notEqual(rendered.volumes['omnis-postgres-data'].external, true);
    assert.notEqual(rendered.networks.edge.external, true);
    assert.notEqual(rendered.networks.data.external, true);
    assert.ok(!JSON.stringify(rendered).includes('/var/run/docker.sock'));
    assert.ok(!JSON.stringify(rendered).includes('/run/docker.sock'));
  }
  assert.equal(mockServices.postgres.volumes[0].source, config.services.postgres.volumes[0].source);
  assert.equal(
    mockConfig.volumes['omnis-postgres-data'].name,
    config.volumes['omnis-postgres-data'].name,
  );
  assert.deepEqual(mockServices.web.volumes ?? [], config.services.web.volumes ?? []);

  const packageManifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageManifest.packageManager, 'pnpm@12.16.1');
  assert.match(readFileSync('pnpm-lock.yaml', 'utf8'), /^lockfileVersion: '9\.0'$/m);
  const imageFiles = {
    api: {
      dockerfile: 'infra/docker/api.Dockerfile',
      ignoreFile: 'infra/docker/api.Dockerfile.dockerignore',
      buildCommand: 'pnpm --filter @omnis/api build',
      outputMarker: '/out/api/',
    },
    worker: {
      dockerfile: 'infra/docker/worker.Dockerfile',
      ignoreFile: 'infra/docker/worker.Dockerfile.dockerignore',
      buildCommand: 'pnpm --filter @omnis/worker build',
      outputMarker: '/out/worker/',
    },
    web: {
      dockerfile: 'infra/docker/web.Dockerfile',
      ignoreFile: 'infra/docker/web.Dockerfile.dockerignore',
      buildCommand: 'pnpm --filter @omnis/web build',
      outputMarker: '/workspace/apps/web/dist/',
    },
  };
  const requiredIgnoreRules = [
    '**/.env',
    '**/.env.*',
    '**/.npmrc',
    '**/*.env',
    '**/*.pem',
    '**/*.key',
    '**/*.p12',
    '**/*.pfx',
    '**/id_rsa*',
    '**/id_ed25519*',
    '**/secrets',
    '**/secrets/**',
    '**/credentials',
    '**/credentials/**',
  ];
  for (const [serviceName, target] of Object.entries(imageFiles)) {
    const dockerfile = readFileSync(target.dockerfile, 'utf8');
    const imagePins = [
      ...dockerfile.matchAll(
        /^FROM (node:24\.22\.1-bookworm-slim@sha256:[a-f0-9]{64}) AS (?:build|runtime)$/gm,
      ),
    ];
    assert.equal(imagePins.length, 2, `${target.dockerfile} must pin build and runtime images`);
    assert.equal(imagePins[0][1], imagePins[1][1]);
    assert.equal(
      [...dockerfile.matchAll(/npm install --global pnpm@12\.16\.1/g)].length,
      1,
      `${target.dockerfile} must install the pinned pnpm once`,
    );
    assert.equal([...dockerfile.matchAll(/pnpm install --frozen-lockfile/g)].length, 1);
    assert.ok(dockerfile.includes(target.buildCommand));
    assert.ok(dockerfile.includes(target.outputMarker));
    assert.ok(dockerfile.includes('verify-stage2a-artifact.mjs'));
    assert.match(dockerfile, /COPY --from=build/);
    assert.match(dockerfile, /USER 10001:10001/);
    assert.doesNotMatch(
      dockerfile,
      /^\s*ARG\s+\S*(?:PASSWORD|TOKEN|SECRET|CREDENTIAL|DATABASE_URL|API_KEY)/im,
    );
    assert.doesNotMatch(
      dockerfile,
      /^\s*ENV\s+\S*(?:PASSWORD|TOKEN|SECRET|CREDENTIAL|DATABASE_URL|API_KEY)=/im,
    );
    assert.doesNotMatch(dockerfile, /\b(?:curl|wget|apt-get|git\s+clone)\b/i);
    assert.doesNotMatch(dockerfile, /^\s*ADD\s+https?:/im);
    assert.doesNotMatch(dockerfile, /--network=host|--mount=type=secret/i);
    const copyStages = [...dockerfile.matchAll(/^COPY --from=(\S+)/gm)].map((match) => match[1]);
    assert.ok(copyStages.length > 0);
    assert.ok(
      copyStages.every((stage) => stage === 'build'),
      `${target.dockerfile} may only copy artifacts from the pinned build stage`,
    );
    assert.equal(config.services[serviceName].build.dockerfile, target.dockerfile);
    assert.equal(config.services[serviceName].build.args, undefined);
    assert.equal(config.services[serviceName].build.secrets, undefined);

    const ignoreLines = readFileSync(target.ignoreFile, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const lastAllowRule = ignoreLines.reduce(
      (last, line, index) => (line.startsWith('!') ? index : last),
      -1,
    );
    for (const rule of requiredIgnoreRules) {
      assert.ok(
        ignoreLines.lastIndexOf(rule) > lastAllowRule,
        `${target.ignoreFile} must exclude ${rule} after allowlists`,
      );
    }
  }

  const rootIgnoreLines = readFileSync('.dockerignore', 'utf8').split(/\r?\n/);
  for (const rule of [
    '.npmrc',
    '.env',
    '.env.*',
    '**/.env',
    '**/.env.*',
    '**/.npmrc',
    '*.env',
    '**/*.env',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '**/id_rsa*',
    '**/id_ed25519*',
    '**/secrets/**',
    '**/credentials/**',
  ]) {
    assert.ok(rootIgnoreLines.includes(rule), `.dockerignore must exclude ${rule}`);
  }
  assert.ok(readFileSync('scripts/ci/verify-stage2a-artifact.mjs', 'utf8').length > 0);

  const roleProvisionSource = readFileSync('packages/db/src/provision-roles.ts', 'utf8');
  for (const role of ['omnis_migrator', 'omnis_runtime', 'omnis_authorizer', 'omnis_launcher']) {
    assert.ok(roleProvisionSource.includes(`'${role}'`));
  }
  const migrationSource = readFileSync('apps/worker/src/migrate.ts', 'utf8');
  assert.ok(migrationSource.includes('await migrate(pool)'));
  assert.ok(migrationSource.includes('await boss.createQueue('));
  for (const service of Object.values(config.services)) {
    assert.equal(
      service.command ?? undefined,
      undefined,
      'Compose must not run provisioning or migrations implicitly',
    );
  }
  const appComposeSource = readFileSync('infra/compose/docker-compose.app.yml', 'utf8');
  assert.doesNotMatch(appComposeSource, /db:(?:roles|migrate)/);

  process.stdout.write(
    'Restricted Compose, persistence, Dockerfile, and context-boundary static checks passed.\n',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
