import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  AgentDirectoryResponse,
  AgentProfileResponse,
  AgentProfileVersionResponse,
  AgentProfileVersionsResponse,
  AgentSummary,
} from '@omnis/contracts';

type AgentRow = {
  id: string;
  name: string;
  slug: string;
  department_id: string | null;
  department_slug: string | null;
  department_name: string | null;
  lifecycle: AgentSummary['lifecycle'];
  archived_at: Date | null;
  current_version_no: number | null;
  provenance: AgentSummary['provenance'];
  created_at: Date;
  updated_at: Date;
  profession: string | null;
  seniority: string | null;
};

type VersionRow = {
  version_id: string;
  agent_id: string;
  version_no: number;
  profession: string;
  seniority: string | null;
  specialties: string[];
  personality: { traits: string[]; tone: string | null; principles: string[] };
  behavior: { autonomy: string | null; escalation: string | null };
  instructions: string;
  created_by_id: string;
  created_by_display_name: string;
  created_at: Date;
};

type Cursor = {
  version: 1;
  agentId: string;
  highWaterVersionNo: number;
  currentVersionNo: number;
  total: number;
  lastVersionNo: number;
};

const credentialPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|service[_-]?token|credential)\s*[:=]\s*(?:"(?:\\.|[^"\\]){8,}"|'(?:\\.|[^'\\]){8,}'|[^\s,;'"`]{8,})/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
];

const credentialPropertyPattern =
  /^(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|service[_-]?token|credential|credentials|secret|private[_-]?key)$/i;

function normalizeEscapedCredentialText(value: string): string {
  return value
    .replace(/\\+(?:(["']))/g, '$1')
    .replace(/\\u003d/gi, '=')
    .replace(/\\u003a/gi, ':')
    .replace(/\\x3d/gi, '=')
    .replace(/\\x3a/gi, ':');
}

function hasCredentialValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.some(hasCredentialValue);
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function assertNoCredentialMaterial(value: unknown): void {
  if (typeof value === 'string') {
    const normalized = normalizeEscapedCredentialText(value);
    if (credentialPatterns.some((pattern) => pattern.test(normalized))) {
      throw new AgentProfileStoreError(
        'disallowed_credential_material',
        'Agent profile contains disallowed credential material.',
        422,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoCredentialMaterial(entry);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (credentialPropertyPattern.test(key) && hasCredentialValue(entry)) {
        throw new AgentProfileStoreError(
          'disallowed_credential_material',
          'Agent profile contains disallowed credential material.',
          422,
        );
      }
      assertNoCredentialMaterial(entry);
    }
  }
}

export class AgentProfileStoreError extends Error {
  readonly code:
    'not_found' | 'invalid_cursor' | 'directory_limit_exceeded' | 'disallowed_credential_material';
  readonly statusCode: 404 | 422 | 503;

  constructor(
    code:
      | 'not_found'
      | 'invalid_cursor'
      | 'directory_limit_exceeded'
      | 'disallowed_credential_material',
    message: string,
    statusCode: 404 | 422 | 503,
  ) {
    super(message);
    this.name = 'AgentProfileStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const agentSelection = `
  SELECT a.id, a.name, a.slug, a.department_id,
         d.slug AS department_slug, d.name AS department_name,
         a.lifecycle, a.archived_at, a.current_version_no, a.provenance,
         a.created_at, a.updated_at,
         v.profession, v.seniority
    FROM omnis.agents a
    LEFT JOIN omnis.departments d ON d.id = a.department_id AND d.owner_id = a.owner_id
    LEFT JOIN omnis.agent_profile_versions v
      ON v.agent_id = a.id AND v.version_no = a.current_version_no`;

function timestamp(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapAgent(row: AgentRow): AgentSummary {
  const agent: AgentSummary = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    department:
      row.department_id === null
        ? null
        : { id: row.department_id, slug: row.department_slug!, name: row.department_name! },
    lifecycle: row.lifecycle,
    archivedAt: timestamp(row.archived_at),
    currentVersion:
      row.current_version_no === null
        ? null
        : {
            versionNo: row.current_version_no,
            profession: row.profession!,
            seniority: row.seniority,
          },
    provenance: row.provenance,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  assertNoCredentialMaterial(agent);
  return agent;
}

function mapVersion(row: VersionRow) {
  const version = {
    versionId: row.version_id,
    agentId: row.agent_id,
    versionNo: row.version_no,
    profession: row.profession,
    seniority: row.seniority,
    specialties: row.specialties,
    personality: row.personality,
    behavior: row.behavior,
    instructions: row.instructions,
    createdBy: { id: row.created_by_id, displayName: row.created_by_display_name },
    createdAt: row.created_at.toISOString(),
  };
  assertNoCredentialMaterial(version);
  return version;
}

async function readTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function deriveCursorSigningKey(internalToken: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(internalToken, 'utf8'),
      Buffer.from('omnis-os/ao-104/cursor-signing/v1', 'utf8'),
      Buffer.from('agent-profile-history-cursor-signature', 'utf8'),
      32,
    ),
  );
}

function cursorSignature(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update('omnis-agent-history-cursor-v1:')
    .update(payload)
    .digest();
}

function decodeCursor(encoded: string, agentId: string, key: Buffer): Cursor {
  try {
    const [payload, suppliedSignature, extra] = encoded.split('.');
    if (!payload || !suppliedSignature || extra !== undefined) throw new Error('Invalid cursor');
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    const expected = cursorSignature(payload, key);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected) ||
      supplied.toString('base64url') !== suppliedSignature
    )
      throw new Error('Invalid cursor');
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const value: unknown = JSON.parse(json);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value && value.version === 1) ||
      !('agentId' in value && value.agentId === agentId) ||
      !('highWaterVersionNo' in value && Number.isSafeInteger(value.highWaterVersionNo)) ||
      !('currentVersionNo' in value && Number.isSafeInteger(value.currentVersionNo)) ||
      !('total' in value && Number.isSafeInteger(value.total)) ||
      !('lastVersionNo' in value && Number.isSafeInteger(value.lastVersionNo))
    )
      throw new Error('Invalid cursor');
    const cursor = value as Cursor;
    if (
      cursor.highWaterVersionNo < 1 ||
      cursor.currentVersionNo < 1 ||
      cursor.total < 1 ||
      cursor.currentVersionNo !== cursor.highWaterVersionNo ||
      cursor.total !== cursor.highWaterVersionNo ||
      cursor.lastVersionNo < 1 ||
      cursor.lastVersionNo > cursor.highWaterVersionNo ||
      Buffer.from(payload, 'base64url').toString('base64url') !== payload
    )
      throw new Error('Invalid cursor');
    return cursor;
  } catch {
    throw new AgentProfileStoreError('invalid_cursor', 'Version history cursor is invalid.', 422);
  }
}

function encodeCursor(cursor: Cursor, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return `${payload}.${cursorSignature(payload, key).toString('base64url')}`;
}

export class PostgresAgentProfileStore {
  private readonly pool: Pool;
  private readonly cursorSigningKey: Buffer;

  constructor(pool: Pool, internalToken: string) {
    if (internalToken.length < 32) throw new Error('Worker internal token is invalid.');
    this.pool = pool;
    this.cursorSigningKey = deriveCursorSigningKey(internalToken);
  }

  async listAgents(): Promise<AgentDirectoryResponse> {
    return readTransaction(this.pool, async (client) => {
      const count = await client.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM omnis.agents',
      );
      const total = Number(count.rows[0]!.total);
      if (total > 1000) {
        throw new AgentProfileStoreError(
          'directory_limit_exceeded',
          'Agent directory exceeds the supported complete response size.',
          503,
        );
      }
      const rows = await client.query<AgentRow>(`${agentSelection} ORDER BY a.name, a.id`);
      return {
        agents: rows.rows.map(mapAgent),
        page: { total, complete: true, nextCursor: null },
      };
    });
  }

  async getAgent(agentId: string): Promise<AgentProfileResponse | null> {
    return readTransaction(this.pool, async (client) => {
      const rows = await client.query<AgentRow>(`${agentSelection} WHERE a.id = $1`, [agentId]);
      const row = rows.rows[0];
      if (!row) return null;
      const agent = mapAgent(row);
      if (row.current_version_no === null) return { agent, currentVersion: null };
      const version = await client.query<VersionRow>(
        `SELECT * FROM omnis.agent_profile_versions WHERE agent_id = $1 AND version_no = $2`,
        [agentId, row.current_version_no],
      );
      return { agent, currentVersion: mapVersion(version.rows[0]!) };
    });
  }

  async getVersion(
    agentId: string,
    versionNo: number,
  ): Promise<AgentProfileVersionResponse | null> {
    return readTransaction(this.pool, async (client) => {
      const rows = await client.query<AgentRow>(`${agentSelection} WHERE a.id = $1`, [agentId]);
      const row = rows.rows[0];
      if (!row) return null;
      const version = await client.query<VersionRow>(
        `SELECT * FROM omnis.agent_profile_versions WHERE agent_id = $1 AND version_no = $2`,
        [agentId, versionNo],
      );
      const snapshot = version.rows[0];
      if (!snapshot) return null;
      return {
        agent: mapAgent(row),
        version: mapVersion(snapshot),
        isCurrent: row.current_version_no === versionNo,
      };
    });
  }

  async listVersions(
    agentId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<AgentProfileVersionsResponse | null> {
    const limit = options.limit ?? 50;
    const suppliedCursor = options.cursor
      ? decodeCursor(options.cursor, agentId, this.cursorSigningKey)
      : undefined;
    return readTransaction(this.pool, async (client) => {
      const agentRows = await client.query<AgentRow>(`${agentSelection} WHERE a.id = $1`, [
        agentId,
      ]);
      const agentRow = agentRows.rows[0];
      if (!agentRow) return null;
      const agent = mapAgent(agentRow);
      if (agentRow.current_version_no === null) {
        return { agent, versions: [], page: { total: 0, complete: true, nextCursor: null } };
      }
      const snapshot =
        suppliedCursor ??
        (await (async () => {
          const totals = await client.query<{ total: string; high_water: number }>(
            `SELECT count(*)::text AS total, COALESCE(max(version_no), 0)::int AS high_water
             FROM omnis.agent_profile_versions WHERE agent_id = $1`,
            [agentId],
          );
          const total = Number(totals.rows[0]!.total);
          const highWaterVersionNo = totals.rows[0]!.high_water;
          if (total < 1 || highWaterVersionNo !== agentRow.current_version_no) {
            throw new Error('Agent profile version head is inconsistent.');
          }
          return {
            version: 1 as const,
            agentId,
            highWaterVersionNo,
            currentVersionNo: agentRow.current_version_no,
            total,
          };
        })());
      const currentVersionRow = await client.query<VersionRow>(
        `SELECT * FROM omnis.agent_profile_versions WHERE agent_id = $1 AND version_no = $2`,
        [agentId, snapshot.currentVersionNo],
      );
      if (!currentVersionRow.rows[0])
        throw new Error('Snapshot current profile version is missing.');
      agent.currentVersion = {
        versionNo: snapshot.currentVersionNo,
        profession: currentVersionRow.rows[0].profession,
        seniority: currentVersionRow.rows[0].seniority,
      };
      const versions = await client.query<VersionRow>(
        `SELECT * FROM omnis.agent_profile_versions
          WHERE agent_id = $1 AND version_no <= $2 AND ($3::integer IS NULL OR version_no < $3)
          ORDER BY version_no DESC LIMIT $4`,
        [agentId, snapshot.highWaterVersionNo, suppliedCursor?.lastVersionNo ?? null, limit + 1],
      );
      const hasNext = versions.rows.length > limit;
      const pageRows = versions.rows.slice(0, limit);
      const lastVersionNo = pageRows.at(-1)?.version_no;
      const nextCursor =
        hasNext && lastVersionNo !== undefined
          ? encodeCursor({ ...snapshot, lastVersionNo }, this.cursorSigningKey)
          : null;
      return {
        agent,
        versions: pageRows.map((row) => {
          const version = {
            versionId: row.version_id,
            versionNo: row.version_no,
            profession: row.profession,
            seniority: row.seniority,
            createdAt: row.created_at.toISOString(),
            createdBy: { id: row.created_by_id, displayName: row.created_by_display_name },
            isCurrent: row.version_no === snapshot.currentVersionNo,
          };
          assertNoCredentialMaterial(version);
          return version;
        }),
        page: { total: snapshot.total, complete: nextCursor === null, nextCursor },
      };
    });
  }
}
