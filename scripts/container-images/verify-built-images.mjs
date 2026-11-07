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
  {
    name: 'omnis-web:ci',
    user: '10001:10001',
    command: ['node', 'server.mjs'],
  },
  { name: 'omnis-web-assets:ci', user: '65532:65532', command: null },
];

for (const dockerfile of [
  'infra/docker/api.Dockerfile',
  'infra/docker/worker.Dockerfile',
  'infra/docker/web.Dockerfile',
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

const invalidWebConfig = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--env',
    'OMNIS_API_URL=https://provider.example.invalid',
    'omnis-web:ci',
  ],
  { encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024 },
);
if (
  invalidWebConfig.error ||
  invalidWebConfig.status === 0 ||
  !`${invalidWebConfig.stdout ?? ''}${invalidWebConfig.stderr ?? ''}`.includes(
    'private Compose API service endpoint',
  )
) {
  throw new Error('The web image did not reject an unapproved API endpoint.');
}

const proxyNetwork = `omnis-web-proxy-${process.pid}`;
const fakeApi = `omnis-web-fake-api-${process.pid}`;
const webContainer = `omnis-web-app-${process.pid}`;
try {
  execFileSync('docker', ['network', 'create', '--internal', proxyNetwork], {
    encoding: 'utf8',
  });
  const fakeApiSource =
    "require('node:http').createServer((req,res)=>{if(req.url==='/api/v1/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: fixture\\ndata: connected\\n\\n');setTimeout(()=>res.end(),30);return}res.writeHead(200,{'content-type':'application/json; charset=utf-8','set-cookie':'fixture=session; HttpOnly'});res.end(JSON.stringify({path:req.url,origin:req.headers.origin,cookie:req.headers.cookie}))}).listen(4100,'0.0.0.0')";
  execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      fakeApi,
      '--network',
      proxyNetwork,
      '--network-alias',
      'api',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--memory',
      '128m',
      '--entrypoint',
      'node',
      'node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c',
      '-e',
      fakeApiSource,
    ],
    { encoding: 'utf8' },
  );
  execFileSync(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--name',
      webContainer,
      '--network',
      proxyNetwork,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--pids-limit',
      '64',
      '--memory',
      '256m',
      '--cpus',
      '0.5',
      'omnis-web:ci',
    ],
    { encoding: 'utf8' },
  );
  const webCheck = String.raw`
    import assert from 'node:assert/strict';
    import http from 'node:http';
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    let health;
    for(let n=0;n<30;n++){try{health=await fetch('http://127.0.0.1:8080/health');if(health.ok)break}catch{}await wait(100)}
    assert.ok(health?.ok,'web health endpoint did not start');
    assert.deepEqual(await health.json(),{status:'ok',product:'Omnis OS'});
    const page=await fetch('http://127.0.0.1:8080/');
    assert.equal(page.status,200);
    assert.match(await page.text(),/Omnis OS/);
    const traversal=await new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:8080,path:'/%2e%2e%2fetc/passwd'},resolve).on('error',reject));
    assert.equal(traversal.statusCode,404);
    traversal.resume();
    const rejectedMethod=await fetch('http://127.0.0.1:8080/',{method:'POST'});
    assert.equal(rejectedMethod.status,405);
    const proxied=await fetch('http://127.0.0.1:8080/api/v1/health',{headers:{origin:'https://omnis.example.invalid',cookie:'owner=session-fixture'}});
    assert.equal(proxied.status,200);
    assert.equal(proxied.headers.get('set-cookie'),'fixture=session; HttpOnly');
    assert.deepEqual(await proxied.json(),{path:'/api/v1/health',origin:'https://omnis.example.invalid',cookie:'owner=session-fixture'});
    const stream=await fetch('http://127.0.0.1:8080/api/v1/events');
    assert.equal(stream.status,200);
    assert.match(await stream.text(),/event: fixture\ndata: connected/);
  `;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      execFileSync('docker', ['exec', webContainer, 'node', '-e', webCheck], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      });
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (lastError)
    throw new Error('The web image failed its static, proxy, or SSE smoke test.', {
      cause: lastError,
    });
  process.stdout.write('Web image static delivery, API proxy, cookies, and SSE verified.\n');
} finally {
  spawnSync('docker', ['rm', '-f', fakeApi, webContainer], { stdio: 'ignore', timeout: 10000 });
  spawnSync('docker', ['network', 'rm', proxyNetwork], { stdio: 'ignore', timeout: 10000 });
}

const tempDirectory = mkdtempSync(join(tmpdir(), 'omnis-image-check-'));
try {
  const canary =
    process.env.OMNIS_IMAGE_CANARY ?? readFileSync('.env.container-image-canary', 'utf8');
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
