import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const images = [
  {
    name: 'omnis-api:ci',
    user: '10001:10001',
    command: ['node', '--experimental-strip-types', 'src/server.ts'],
  },
  {
    name: 'omnis-worker:ci',
    user: '10001:10001',
    command: ['node', '--experimental-strip-types', 'src/server.ts'],
  },
  { name: 'omnis-web-assets:ci', user: '65532:65532', command: null },
];

for (const dockerfile of [
  'infra/docker/api.Dockerfile',
  'infra/docker/worker.Dockerfile',
  'infra/docker/web-assets.Dockerfile',
]) {
  const source = readFileSync(dockerfile, 'utf8');
  if (/docker\.sock|--privileged|\bVOLUME\b|SYS_ADMIN|CAP_ADD/i.test(source)) {
    throw new Error(`${dockerfile} contains an unapproved privilege or host-mount directive.`);
  }
}

for (const expected of images) {
  const [image] = JSON.parse(
    execFileSync('docker', ['image', 'inspect', expected.name], { encoding: 'utf8' }),
  );
  if (image.Config.User !== expected.user) {
    throw new Error(`${expected.name} has an unexpected configured user.`);
  }
  if (expected.command && JSON.stringify(image.Config.Cmd) !== JSON.stringify(expected.command)) {
    throw new Error(`${expected.name} has an unexpected startup command.`);
  }
  if (
    !expected.command &&
    (image.Config.Cmd || image.Config.Entrypoint || image.Config.ExposedPorts)
  ) {
    throw new Error(
      `${expected.name} must remain a static-asset image without a server command or ports.`,
    );
  }
  if (
    JSON.stringify(image.Config.Env ?? []).match(/(OMNIS_|DATABASE_URL|PASSWORD|TOKEN|SECRET)/i)
  ) {
    throw new Error(
      `${expected.name} contains a configuration variable that must be runtime-only.`,
    );
  }
  if (image.Config.Volumes || image.Config.Privileged) {
    throw new Error(`${expected.name} declares an unexpected volume or privileged setting.`);
  }
}

// Start the final images: a module-loader crash is never a configuration pass.
for (const [image, reason] of [
  ['omnis-api:ci', 'OMNIS_SESSION_SECRET must be generated'],
  ['omnis-worker:ci', 'OMNIS_INTERNAL_TOKEN must be generated'],
]) {
  const name = `omnis-startup-${process.pid}-${image.split(':')[0]}`;
  try {
    const identity = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        `${name}-identity`,
        '--network',
        'none',
        '--entrypoint',
        'node',
        image,
        '-e',
        'if(process.getuid()!==10001 || process.getgid()!==10001) process.exit(1)',
      ],
      { encoding: 'utf8', timeout: 15000 },
    );
    if (identity.trim()) throw new Error('Unexpected image identity output.');
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        name,
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--pids-limit',
        '64',
        '--memory',
        '128m',
        '--cpus',
        '0.5',
        image,
      ],
      { encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (
      result.error ||
      result.status === 0 ||
      !output.includes(reason) ||
      /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|ERR_MODULE_NOT_FOUND|SyntaxError/.test(output)
    ) {
      throw new Error(`${image} did not reach its expected application configuration error.`);
    }
    process.stdout.write(
      `${image}: runtime UID/GID and expected configuration failure verified.\n`,
    );
  } finally {
    spawnSync('docker', ['rm', '-f', name, `${name}-identity`], {
      stdio: 'ignore',
      timeout: 10000,
    });
  }
}

const tempDirectory = mkdtempSync(join(tmpdir(), 'omnis-image-check-'));
try {
  const canary = readFileSync('.env.container-image-canary', 'utf8');
  for (const expected of images) {
    const archivePath = join(tempDirectory, `${expected.name.replaceAll(':', '-')}.tar`);
    execFileSync('docker', ['image', 'save', '--output', archivePath, expected.name]);
    const scan = spawnSync(
      'grep',
      ['--recursive', '--binary-files=text', '--quiet', '--fixed-strings', canary, archivePath],
      { encoding: 'utf8' },
    );
    if (scan.status === 0) {
      throw new Error(`${expected.name} contains the synthetic build-context canary.`);
    }
    if (scan.status !== 1) {
      throw new Error(`Could not complete the ${expected.name} canary scan.`);
    }
  }

  const containerId = execFileSync(
    'docker',
    ['create', '--entrypoint', '/__inspection_only__', 'omnis-web-assets:ci'],
    {
      encoding: 'utf8',
    },
  ).trim();
  try {
    execFileSync('docker', [
      'cp',
      `${containerId}:/usr/share/omnis-os/web/index.html`,
      join(tempDirectory, 'index.html'),
    ]);
    readFileSync(join(tempDirectory, 'index.html'));
  } finally {
    execFileSync('docker', ['rm', containerId], { stdio: 'ignore' });
  }
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}

process.stdout.write('Container image metadata and static web assets verified.\n');
