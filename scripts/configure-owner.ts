import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const scrypt = promisify(scryptCallback);
const destinations = [
  '.env',
  '.env.worker',
  '.env.authorizer',
  '.env.sandbox-launcher',
  '.env.migration',
  '.env.db-admin',
].map((name) => new URL(`../${name}`, import.meta.url));
for (const destination of destinations) {
  if ((await readFile(destination, 'utf8').catch(() => '')).trim()) {
    throw new Error(
      `${destination.pathname.split('/').at(-1)} already exists; refusing to replace local secrets.`,
    );
  }
}

const input = createInterface({ input: stdin, output: stdout });
try {
  const password = await input.question('Choose the local Omnis OS owner password: ');
  const confirmation = await input.question('Confirm the local owner password: ');
  if (password.length < 14 || password !== confirmation) {
    throw new Error('Passwords must match and contain at least 14 characters.');
  }

  const salt = randomBytes(16);
  const key = (await scrypt(password, salt, 64)) as Buffer;
  const workerToken = randomBytes(48).toString('hex');
  const apiAuthorizerToken = randomBytes(48).toString('hex');
  const sharedLines = [
    `OMNIS_OWNER_PASSWORD_HASH=${salt.toString('hex')}:${key.toString('hex')}`,
    `OMNIS_SESSION_SECRET=${randomBytes(48).toString('hex')}`,
    `OMNIS_INTERNAL_TOKEN=${workerToken}`,
    `OMNIS_API_AUTHORIZER_TOKEN=${apiAuthorizerToken}`,
    'OMNIS_ALLOWED_ORIGIN=http://127.0.0.1:5173',
    'OMNIS_API_HOST=127.0.0.1',
    'OMNIS_API_PORT=4100',
    'OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock',
    'OMNIS_SECURE_COOKIES=false',
  ];
  const files = [
    sharedLines,
    [
      `OMNIS_INTERNAL_TOKEN=${workerToken}`,
      `OMNIS_RUNTIME_DB_PASSWORD=${randomBytes(32).toString('hex')}`,
      'OMNIS_WORKER_HOST=127.0.0.1',
      'OMNIS_WORKER_PORT=4101',
      'OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock',
      'OMNIS_QUEUE_NAME=omnis-mock-run',
    ],
    [
      `OMNIS_API_AUTHORIZER_TOKEN=${apiAuthorizerToken}`,
      `OMNIS_AUTHORIZER_DB_PASSWORD=${randomBytes(32).toString('hex')}`,
      'OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock',
      'OMNIS_AUTHORIZER_SOCKET_MODE=660',
      'OMNIS_DB_HOST=127.0.0.1',
      'OMNIS_DB_PORT=5432',
      'OMNIS_DB_NAME=omnis',
    ],
    [
      `OMNIS_LAUNCHER_DB_PASSWORD=${randomBytes(32).toString('hex')}`,
      'OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock',
      'OMNIS_SANDBOX_LAUNCHER_SOCKET_MODE=660',
    ],
    [`OMNIS_MIGRATION_DB_PASSWORD=${randomBytes(32).toString('hex')}`],
    [`OMNIS_DB_PASSWORD=${randomBytes(32).toString('hex')}`],
  ];
  for (const [index, destination] of destinations.entries()) {
    await writeFile(destination, `${files[index]!.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(destination, 0o600);
  }
  stdout.write(
    'Created private Omnis API, worker, authorizer, sandbox-launcher, migration, and database-admin environment files.\n',
  );
} finally {
  input.close();
}
