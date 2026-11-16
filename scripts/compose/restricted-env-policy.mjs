import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { URL } from 'node:url';

export const RESTRICTED_COMPOSE_ENV_ALLOWLIST = new Set([
  'OMNIS_RESTRICTED_DB_NAME',
  'OMNIS_DB_PASSWORD',
  'OMNIS_WEB_PORT',
  'OMNIS_RESTRICTED_API_ENV_FILE',
  'OMNIS_RESTRICTED_WORKER_ENV_FILE',
]);

export const RESTRICTED_API_ENV_ALLOWLIST = new Set([
  'OMNIS_OWNER_PASSWORD_HASH',
  'OMNIS_SESSION_SECRET',
  'OMNIS_INTERNAL_TOKEN',
  'OMNIS_ALLOWED_ORIGIN',
  'OMNIS_SECURE_COOKIES',
]);

export const RESTRICTED_WORKER_ENV_ALLOWLIST = new Set([
  'OMNIS_INTERNAL_TOKEN',
  'OMNIS_RUNTIME_DB_PASSWORD',
]);

// Compose gives exported shell variables precedence over values in --env-file.
// Keep the restricted profile's interpolation inputs sourced only from its
// validated env file; remove Compose controls as well so they cannot select
// another project, file set, or profile.
export function restrictedComposeEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    if (key.startsWith('OMNIS_') || key.startsWith('COMPOSE_')) delete sanitized[key];
  }
  return sanitized;
}

const REQUIRED_API_KEYS = [...RESTRICTED_API_ENV_ALLOWLIST];
const REQUIRED_WORKER_KEYS = [...RESTRICTED_WORKER_ENV_ALLOWLIST];
const REQUIRED_COMPOSE_KEYS = [
  'OMNIS_RESTRICTED_DB_NAME',
  'OMNIS_DB_PASSWORD',
  'OMNIS_RESTRICTED_API_ENV_FILE',
  'OMNIS_RESTRICTED_WORKER_ENV_FILE',
];
const SECRET_HEX = /^[a-f0-9]{64,}$/i;
const OWNER_HASH = /^[a-f0-9]{32}:[a-f0-9]{128}$/i;

function readAllowlistedEnvFile(path, service, allowlist, requiredKeys) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o177) !== 0 ||
    (stat.mode & 0o400) === 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      `${service} restricted env file must be a private, regular file owned by the current user.`,
    );
  }
  const contents = readFileSync(path, 'utf8');
  const values = Object.create(null);

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const line = rawLine;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(
        `${service} restricted env file has unsupported syntax on line ${index + 1}; ` +
          'use KEY=value or a comment.',
      );
    }

    const [, key, value] = match;
    if (!allowlist.has(key)) {
      throw new Error(`${service} restricted env file contains disallowed variable ${key}.`);
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`${service} restricted env file repeats variable ${key}.`);
    }
    if (!value || value !== value.trim() || /[\0\r\n'"`]/.test(value)) {
      throw new Error(`${service} restricted env file has an invalid value for ${key}.`);
    }
    values[key] = value;
  }

  for (const key of requiredKeys) {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`${service} restricted env file is missing required variable ${key}.`);
    }
  }

  if (service === 'API') {
    if (!OWNER_HASH.test(values.OMNIS_OWNER_PASSWORD_HASH)) {
      throw new Error('API restricted env file has an invalid owner password hash format.');
    }
    for (const key of ['OMNIS_SESSION_SECRET', 'OMNIS_INTERNAL_TOKEN']) {
      if (!SECRET_HEX.test(values[key])) {
        throw new Error(`API restricted env file has an invalid value format for ${key}.`);
      }
    }
    if (!['true', 'false'].includes(values.OMNIS_SECURE_COOKIES)) {
      throw new Error('API restricted env file has an invalid value for OMNIS_SECURE_COOKIES.');
    }
    let origin;
    try {
      origin = new URL(values.OMNIS_ALLOWED_ORIGIN);
    } catch {
      throw new Error('API restricted env file has an invalid OMNIS_ALLOWED_ORIGIN.');
    }
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
      origin.origin !== values.OMNIS_ALLOWED_ORIGIN
    ) {
      throw new Error('API restricted env file origin must be a loopback origin.');
    }
  }

  if (service === 'Worker' && !SECRET_HEX.test(values.OMNIS_RUNTIME_DB_PASSWORD)) {
    throw new Error('Worker restricted env file has an invalid runtime database password format.');
  }

  if (service === 'Compose') {
    if (values.OMNIS_RESTRICTED_DB_NAME !== 'omnis_restricted_dev') {
      throw new Error('Restricted Compose env file must select database omnis_restricted_dev.');
    }
    if (!SECRET_HEX.test(values.OMNIS_DB_PASSWORD)) {
      throw new Error('Restricted Compose env file has an invalid PostgreSQL password format.');
    }
    for (const key of ['OMNIS_RESTRICTED_API_ENV_FILE', 'OMNIS_RESTRICTED_WORKER_ENV_FILE']) {
      if (!isAbsolute(values[key]) || values[key].includes('$')) {
        throw new Error(
          `Restricted Compose env file requires an absolute literal path without interpolation for ${key}.`,
        );
      }
    }
    if (
      values.OMNIS_WEB_PORT !== undefined &&
      (!/^\d+$/.test(values.OMNIS_WEB_PORT) ||
        Number(values.OMNIS_WEB_PORT) < 1024 ||
        Number(values.OMNIS_WEB_PORT) > 65535)
    ) {
      throw new Error('Restricted Compose env file has an invalid OMNIS_WEB_PORT.');
    }
  }

  return values;
}

export function readRestrictedEnvPair(composePath, apiPath, workerPath) {
  const compose = readAllowlistedEnvFile(
    composePath,
    'Compose',
    RESTRICTED_COMPOSE_ENV_ALLOWLIST,
    REQUIRED_COMPOSE_KEYS,
  );
  if (
    compose.OMNIS_RESTRICTED_API_ENV_FILE !== apiPath ||
    compose.OMNIS_RESTRICTED_WORKER_ENV_FILE !== workerPath
  ) {
    throw new Error(
      'Restricted Compose env-file paths must match the validated API and Worker files.',
    );
  }
  const api = readAllowlistedEnvFile(
    apiPath,
    'API',
    RESTRICTED_API_ENV_ALLOWLIST,
    REQUIRED_API_KEYS,
  );
  const worker = readAllowlistedEnvFile(
    workerPath,
    'Worker',
    RESTRICTED_WORKER_ENV_ALLOWLIST,
    REQUIRED_WORKER_KEYS,
  );

  if (api.OMNIS_INTERNAL_TOKEN !== worker.OMNIS_INTERNAL_TOKEN) {
    throw new Error('Restricted API and Worker env files must use the same internal token.');
  }

  return { compose, api, worker };
}
