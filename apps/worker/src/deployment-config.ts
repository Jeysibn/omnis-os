export interface WorkerDatabaseConfiguration {
  databaseUrl?: string | undefined;
  password?: string | undefined;
  host?: string | undefined;
  port?: string | undefined;
  database?: string | undefined;
  privateCompose?: boolean | undefined;
}

export function validateWorkerBindHost(host: string, privateCompose: boolean): void {
  if (
    !['127.0.0.1', '::1', 'localhost'].includes(host) &&
    !(privateCompose && host === '0.0.0.0')
  ) {
    throw new Error(
      'The initial Omnis worker must bind to loopback or private Compose networking.',
    );
  }
}

export function createRuntimeDatabaseUrl(config: WorkerDatabaseConfiguration): string {
  if (config.databaseUrl) {
    const parsed = new URL(config.databaseUrl);
    if (
      !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname) &&
      !(config.privateCompose && parsed.hostname === 'postgres')
    ) {
      throw new Error(
        'The initial worker database must be reachable through approved local Compose networking.',
      );
    }
    if (parsed.username !== 'omnis_runtime') {
      throw new Error('The worker database connection must use the restricted omnis_runtime role.');
    }
    return config.databaseUrl;
  }
  if (!config.password)
    throw new Error('OMNIS_DATABASE_URL or OMNIS_RUNTIME_DB_PASSWORD must be configured.');
  const host = config.host ?? '127.0.0.1';
  const port = Number(config.port ?? 5432);
  const database = config.database ?? 'omnis';
  if (
    !['127.0.0.1', '::1', 'localhost'].includes(host) &&
    !(config.privateCompose && host === 'postgres')
  ) {
    throw new Error('The worker database host must use approved local Compose networking.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('OMNIS_DB_PORT must be a valid TCP port.');
  if (!/^[A-Za-z0-9_]{1,63}$/.test(database)) throw new Error('OMNIS_DB_NAME is invalid.');
  return `postgresql://omnis_runtime:${encodeURIComponent(config.password)}@${host}:${port}/${database}`;
}
