import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { AgentProfileStoreError, PostgresAgentProfileStore } from './agent-profile-store.ts';

const internalToken = 'synthetic-worker-internal-token-value-0123456789abcdef';
const createdAt = new Date('2026-11-04T00:00:00.000Z');

function agentRow(currentVersionNo = 1) {
  return {
    id: 'agt_atlas',
    name: 'Atlas',
    slug: 'atlas',
    department_id: null,
    department_slug: null,
    department_name: null,
    lifecycle: 'available',
    archived_at: null,
    current_version_no: currentVersionNo,
    provenance: 'owner_created',
    created_at: createdAt,
    updated_at: createdAt,
    profession: 'Systems Analyst',
    seniority: 'senior',
  };
}

function versionRow(versionNo = 1, overrides: Record<string, unknown> = {}) {
  return {
    version_id: `apv_atlas_${versionNo}`,
    agent_id: 'agt_atlas',
    version_no: versionNo,
    profession: 'Systems Analyst',
    seniority: 'senior',
    specialties: ['system-design'],
    personality: { traits: ['methodical'], tone: 'professional', principles: [] },
    behavior: { autonomy: null, escalation: 'request owner review' },
    instructions: 'Summarize the approved internal design notes.',
    created_by_id: 'owner',
    created_by_display_name: 'Owner',
    created_at: createdAt,
    ...overrides,
  };
}

function mockPool(
  options: {
    agent?: ReturnType<typeof agentRow>;
    versions?: ReturnType<typeof versionRow>[];
    total?: number;
  } = {},
) {
  const agent = options.agent ?? agentRow();
  const versions = options.versions ?? [versionRow()];
  const total = options.total ?? versions.length;
  return {
    async connect() {
      return {
        async query(sql: string, params: unknown[] = []) {
          if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
          if (sql.includes('FROM omnis.agents a')) return { rows: [agent] };
          if (sql.includes('count(*)::text AS total, COALESCE(max(version_no)')) {
            return { rows: [{ total: String(total), high_water: agent.current_version_no }] };
          }
          if (
            sql.includes('SELECT * FROM omnis.agent_profile_versions') &&
            sql.includes('WHERE agent_id = $1 AND version_no = $2')
          ) {
            const selected = versions.find((version) => version.version_no === params[1]);
            return { rows: selected ? [selected] : [] };
          }
          if (sql.includes('FROM omnis.agent_profile_versions')) {
            const highWater = params[1] as number;
            const before = params[2] as number | null;
            const limit = params[3] as number;
            return {
              rows: versions
                .filter((version) => version.version_no <= highWater)
                .filter((version) => before === null || version.version_no < before)
                .sort((left, right) => right.version_no - left.version_no)
                .slice(0, limit),
            };
          }
          throw new Error('Unexpected test query.');
        },
        release() {},
      };
    },
  };
}

function store(pool: ReturnType<typeof mockPool>) {
  return new PostgresAgentProfileStore(pool as never, internalToken);
}

describe('agent profile credential scanning', () => {
  it('rejects quoted, escaped, and nested credential-like strings without exposing their value', async () => {
    const samples = [
      'password: "quoted synthetic-secret-value-123456"',
      String.raw`api_key = \"escaped synthetic-secret-value-123456\"`,
      String.raw`password\u003dsynthetic-secret-value-123456`,
      'password="nested synthetic-secret-value-123456"',
    ];

    for (const [index, instructions] of samples.entries()) {
      const profileStore = store(
        mockPool({
          versions: [
            versionRow(1, {
              instructions:
                index === samples.length - 1 ? 'Ordinary instruction text.' : instructions,
              personality:
                index === samples.length - 1
                  ? { traits: [], tone: null, principles: [instructions] }
                  : { traits: [], tone: null, principles: [] },
            }),
          ],
        }),
      );

      await assert.rejects(profileStore.getVersion('agt_atlas', 1), (error: unknown) => {
        assert.ok(error instanceof AgentProfileStoreError);
        assert.equal(error.code, 'disallowed_credential_material');
        assert.equal(error.statusCode, 422);
        assert.equal(error.message, 'Agent profile contains disallowed credential material.');
        assert.doesNotMatch(error.message, /synthetic-secret-value-123456/);
        return true;
      });
    }
  });

  it('rejects sensitive credential property names at nested object boundaries', async () => {
    const profileStore = store(
      mockPool({
        versions: [
          versionRow(1, {
            personality: {
              traits: [],
              tone: null,
              principles: [],
              metadata: { apiKey: 'synthetic-secret-value-123456' },
            },
          }),
        ],
      }),
    );

    await assert.rejects(profileStore.getVersion('agt_atlas', 1), {
      code: 'disallowed_credential_material',
      statusCode: 422,
    });
  });

  it('fails closed when historical version summaries contain credential-like values', async () => {
    const profileStore = store(
      mockPool({
        versions: [
          versionRow(1, {
            profession: 'password = "history synthetic-secret-value-123456"',
            instructions: 'Safe detail text.',
          }),
        ],
      }),
    );

    await assert.rejects(profileStore.listVersions('agt_atlas'), (error: unknown) => {
      assert.ok(error instanceof AgentProfileStoreError);
      assert.equal(error.code, 'disallowed_credential_material');
      assert.equal(error.statusCode, 422);
      assert.doesNotMatch(error.message, /synthetic-secret-value-123456/);
      return true;
    });
  });
});

describe('agent profile cursor key separation', () => {
  it('rejects cursors signed directly with the worker bearer token', async () => {
    const cursor = {
      version: 1,
      agentId: 'agt_atlas',
      highWaterVersionNo: 2,
      currentVersionNo: 2,
      total: 2,
      lastVersionNo: 1,
    };
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    const signature = createHmac('sha256', internalToken)
      .update('omnis-agent-history-cursor-v1:')
      .update(payload)
      .digest('base64url');
    const noConnectPool = {
      async connect() {
        throw new Error('Invalid cursor reached the database.');
      },
    };
    const profileStore = new PostgresAgentProfileStore(noConnectPool as never, internalToken);

    await assert.rejects(
      profileStore.listVersions('agt_atlas', { cursor: `${payload}.${signature}` }),
      { code: 'invalid_cursor', statusCode: 422 },
    );
  });

  it('keeps derived-key cursors stable across store instances and rejects them after token rotation', async () => {
    const pool = mockPool({
      agent: agentRow(3),
      versions: [versionRow(1), versionRow(2), versionRow(3)],
      total: 3,
    });
    const firstPage = await store(pool).listVersions('agt_atlas', { limit: 1 });
    const cursor = firstPage?.page.nextCursor;
    assert.ok(cursor);

    const nextPage = await store(pool).listVersions('agt_atlas', { limit: 1, cursor });
    assert.deepEqual(
      nextPage?.versions.map((version) => version.versionNo),
      [2],
    );

    const rotatedTokenStore = new PostgresAgentProfileStore(
      pool as never,
      'different-synthetic-worker-token-0123456789abcdef',
    );
    await assert.rejects(rotatedTokenStore.listVersions('agt_atlas', { cursor }), {
      code: 'invalid_cursor',
      statusCode: 422,
    });
  });
});
