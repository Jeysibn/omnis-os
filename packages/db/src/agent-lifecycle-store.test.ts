import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Pool } from 'pg';
import { AgentLifecycleStoreError, PostgresAgentLifecycleStore } from './agent-lifecycle-store.ts';

describe('agent lifecycle write validation', () => {
  it('maps rejected profile material to the safe lifecycle error before database access', async () => {
    let queryCount = 0;
    const pool = {
      async query() {
        queryCount += 1;
        throw new Error('unexpected database access');
      },
    } as unknown as Pool;
    const store = new PostgresAgentLifecycleStore(pool, Buffer.alloc(32, 7));
    const secret = 'password: "synthetic-secret-value-123';

    await assert.rejects(
      store.saveDraft(
        'agt_test',
        {
          expectedDraftRevision: 0,
          baseVersionNo: null,
          profile: {
            profession: 'Analyst',
            seniority: null,
            specialties: [],
            personality: { traits: [], tone: null, principles: [] },
            behavior: { autonomy: null, escalation: null },
            instructions: secret,
          },
        },
        '01933e57-a489-7ca1-a42c-7b9a8290c52c',
      ),
      (error: unknown) => {
        assert.ok(error instanceof AgentLifecycleStoreError);
        assert.equal(error.code, 'disallowed_credential_material');
        assert.equal(error.statusCode, 422);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(queryCount, 0);
  });
});
