import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AgentDirectoryResponseSchema,
  AgentProfileResponseSchema,
  AgentProfileVersionResponseSchema,
  AgentProfileVersionsResponseSchema,
  AgentVersionQuerySchema,
  RunEventSchema,
  RunSchema,
  RunStatusSchema,
} from './index.ts';

describe('run contracts', () => {
  it('accepts only events marked as synthetic mock activity', () => {
    const event = {
      id: 'evt-run-0001-0001',
      runId: 'run-0001',
      sequence: 1,
      at: '2026-11-02T00:00:00.000Z',
      type: 'run.queued',
      source: 'mock',
      synthetic: true,
      message: 'Queued.',
    };
    assert.equal(RunEventSchema.parse(event).synthetic, true);
    assert.equal(
      RunEventSchema.safeParse({ ...event, source: 'hermes', synthetic: false }).success,
      false,
    );
  });

  it('keeps unavailable usage unknown rather than presenting zero', () => {
    const run = {
      id: 'run-0001',
      taskId: 'task-0001',
      taskTitle: 'Read the file list',
      status: 'queued',
      runtimeKind: 'mock',
      synthetic: true,
      usage: { quality: 'unknown', inputTokens: null, outputTokens: null, cost: null },
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    assert.equal(RunSchema.parse(run).usage.inputTokens, null);
    assert.equal(
      RunSchema.safeParse({ ...run, usage: { quality: 'measured', inputTokens: 0 } }).success,
      false,
    );
  });

  it('represents interrupted execution explicitly and as synthetic mock evidence', () => {
    const event = RunEventSchema.parse({
      id: 'evt-run-0001-0004',
      runId: 'run-0001',
      sequence: 4,
      at: '2026-11-02T00:00:00.000Z',
      type: 'run.interrupted',
      source: 'mock',
      synthetic: true,
      message: 'The worker stopped before the run reached a terminal state.',
    });
    assert.equal(event.type, 'run.interrupted');
    assert.equal(RunStatusSchema.parse('interrupted'), 'interrupted');
  });
});

describe('agent profile read contracts', () => {
  const at = '2026-11-02T00:00:00.000Z';
  const agent = {
    id: 'agt_atlas',
    name: 'Atlas',
    slug: 'atlas',
    department: { id: 'dep_engineering', slug: 'engineering', name: 'Engineering' },
    lifecycle: 'available',
    archivedAt: null,
    currentVersion: { versionNo: 2, profession: 'Systems Architect', seniority: 'senior' },
    provenance: 'owner_created',
    createdAt: at,
    updatedAt: at,
  };
  const createdBy = { id: 'owner', displayName: 'Director' };
  const version = {
    versionId: 'apv_atlas_2',
    agentId: agent.id,
    versionNo: 2,
    profession: 'Systems Architect',
    seniority: 'senior',
    specialties: ['system-design'],
    personality: {
      traits: ['methodical'],
      tone: 'professional',
      principles: ['explain tradeoffs'],
    },
    behavior: { autonomy: null, escalation: 'request director review' },
    instructions: 'Use clear, evidence-based reasoning.',
    createdBy,
    createdAt: at,
  };

  it('represents an honestly empty, complete directory and validates bounded complete lists', () => {
    const empty = AgentDirectoryResponseSchema.parse({
      agents: [],
      page: { total: 0, complete: true, nextCursor: null },
    });
    assert.equal(empty.page.total, 0);
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [agent],
        page: { total: 2, complete: true, nextCursor: null },
      }).success,
      false,
    );
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [agent],
        page: { total: 1, complete: false, nextCursor: 'next' },
      }).success,
      false,
    );
  });

  it('keeps lifecycle separate from activity and ties draft state to no published version', () => {
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [{ ...agent, lifecycle: 'busy' }],
        page: { total: 1, complete: true, nextCursor: null },
      }).success,
      false,
    );
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [{ ...agent, lifecycle: 'draft', currentVersion: null }],
        page: { total: 1, complete: true, nextCursor: null },
      }).success,
      true,
    );
    assert.equal(
      AgentDirectoryResponseSchema.safeParse({
        agents: [{ ...agent, lifecycle: 'archived', archivedAt: null }],
        page: { total: 1, complete: true, nextCursor: null },
      }).success,
      false,
    );
  });

  it('validates immutable snapshot shape and exact version identity', () => {
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({ agent, version, isCurrent: true }).success,
      true,
    );
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({
        agent,
        version: { ...version, agentId: 'agt_other' },
        isCurrent: true,
      }).success,
      false,
    );
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({
        agent,
        version: { ...version, versionNo: 1 },
        isCurrent: true,
      }).success,
      false,
    );
    assert.equal(
      AgentProfileVersionResponseSchema.safeParse({
        agent,
        version: { ...version, instructions: 'x'.repeat(16_385) },
        isCurrent: true,
      }).success,
      false,
    );
  });

  it('validates current-version consistency and descending version pages', () => {
    assert.equal(
      AgentProfileResponseSchema.safeParse({ agent, currentVersion: version }).success,
      true,
    );
    assert.equal(
      AgentProfileResponseSchema.safeParse({
        agent,
        currentVersion: { ...version, versionNo: 1 },
      }).success,
      false,
    );
    const versionSummary = {
      versionId: version.versionId,
      versionNo: 2,
      profession: version.profession,
      seniority: version.seniority,
      createdAt: at,
      createdBy,
      isCurrent: true,
    };
    assert.equal(
      AgentProfileVersionsResponseSchema.safeParse({
        agent,
        versions: [versionSummary],
        page: { total: 2, complete: false, nextCursor: 'cursor-1' },
      }).success,
      true,
    );
    assert.equal(
      AgentProfileVersionsResponseSchema.safeParse({
        agent,
        versions: [versionSummary, { ...versionSummary, versionNo: 3 }],
        page: { total: 2, complete: true, nextCursor: null },
      }).success,
      false,
    );
    assert.equal(
      AgentProfileVersionsResponseSchema.safeParse({
        agent,
        versions: [{ ...versionSummary, isCurrent: false }],
        page: { total: 2, complete: false, nextCursor: 'cursor-1' },
      }).success,
      false,
    );
  });

  it('accepts only bounded canonical version pagination parameters', () => {
    assert.deepEqual(AgentVersionQuerySchema.parse({ limit: '50' }), { limit: 50 });
    assert.deepEqual(AgentVersionQuerySchema.parse({ cursor: 'opaque_cursor', limit: '10' }), {
      cursor: 'opaque_cursor',
      limit: 10,
    });
    assert.deepEqual(AgentVersionQuerySchema.parse({ limit: '1' }), { limit: 1 });
    assert.deepEqual(AgentVersionQuerySchema.parse({ limit: '100' }), { limit: 100 });
    for (const query of [{ limit: '0' }, { limit: '01' }, { limit: '101' }, { other: 'x' }]) {
      assert.equal(AgentVersionQuerySchema.safeParse(query).success, false);
    }
  });
});
