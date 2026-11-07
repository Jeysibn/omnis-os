import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRenderedRequestDigest } from './connector-authorization.ts';
import { renderSyntheticConnectorRequest } from './synthetic-connector-prompt.ts';

const task = {
  id: 'task-0001',
  title: 'Summarize a note',
  detail: 'Return a concise summary of the task note.',
  status: 'open',
  createdAt: '2026-11-07T00:00:00.000Z',
  associationRevision: 1,
};

const profile = {
  versionId: 'apv_fixture_1',
  agentId: 'fixture-agent',
  versionNo: 1,
  profession: 'Research assistant',
  seniority: null,
  specialties: ['summarization'],
  personality: { traits: ['careful'], tone: 'plain', principles: ['Do not invent facts.'] },
  behavior: { autonomy: 'Ask before external actions.', escalation: null },
  instructions: 'Summarize only the supplied task detail.',
  createdBy: { id: 'owner', displayName: 'Owner' },
  createdAt: '2026-11-07T00:00:00.000Z',
};

describe('versioned synthetic connector prompt renderer', () => {
  it('renders the same exact prompt from the same task and immutable profile version', () => {
    const first = renderSyntheticConnectorRequest(task, profile);
    const second = renderSyntheticConnectorRequest(task, profile);

    assert.equal(first, second);
    assert.match(first, /omnis\.synthetic-connector-request\.v1/);
    assert.match(first, /Summarize only the supplied task detail/);
    assert.equal(createRenderedRequestDigest(first), createRenderedRequestDigest(second));
  });

  it('changes the rendered request when task or profile content changes', () => {
    const original = renderSyntheticConnectorRequest(task, profile);
    assert.notEqual(
      renderSyntheticConnectorRequest({ ...task, detail: 'A different task.' }, profile),
      original,
    );
    assert.notEqual(
      renderSyntheticConnectorRequest(task, {
        ...profile,
        versionNo: 2,
        instructions: 'Use different instructions.',
      }),
      original,
    );
  });

  it('rejects malformed inputs and prompts above the broker contract limit', () => {
    assert.throws(() => renderSyntheticConnectorRequest({ ...task, id: '' }, profile));
    assert.throws(() => renderSyntheticConnectorRequest(task, { ...profile, versionNo: 0 }));
    assert.throws(() =>
      renderSyntheticConnectorRequest({ ...task, detail: 'x'.repeat(32_000) }, profile),
    );
  });
});
