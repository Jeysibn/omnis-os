import { useId, useState } from 'react';
import {
  AgentMutationReceiptSchema,
  CreateAgentInputSchema,
  type CreateAgentInput,
} from '@omnis/contracts';
import { ApiRequestError, request } from '../api.js';
import { profileHash } from './route.js';

type Operation = { input: CreateAgentInput; key: string };

export function AgentCreateForm({
  csrfToken,
  onUnauthorized,
  onCancel,
}: {
  csrfToken: string;
  onUnauthorized: (cause: unknown) => void;
  onCancel: () => void;
}) {
  const ids = { name: useId(), slug: useId() };
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [operation, setOperation] = useState<Operation | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState('');

  async function submit(retry = false) {
    setError('');
    const parsed = CreateAgentInputSchema.safeParse({
      name,
      slug,
      departmentId: null,
    });
    if (!parsed.success) {
      setError('Enter a name and a lowercase slug using letters, numbers, and single hyphens.');
      return;
    }
    const current =
      retry && operation ? operation : { input: parsed.data, key: crypto.randomUUID() };
    setOperation(current);
    setBusy(true);
    try {
      const receipt = await request(
        '/api/v1/agents',
        {
          method: 'POST',
          headers: {
            'x-omnis-csrf': csrfToken,
            'idempotency-key': current.key,
          },
          body: JSON.stringify(current.input),
        },
        (value) => AgentMutationReceiptSchema.parse(value),
      );
      if (receipt.operation !== 'agent.created' || receipt.lifecycle !== 'draft')
        throw new Error('The create response did not confirm a draft agent.');
      window.location.hash = profileHash(receipt.agentId);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        onUnauthorized(cause);
      } else if (cause instanceof ApiRequestError && cause.outcome !== 'rejected') {
        setUnknown(true);
        setError(
          'The create result is unknown. Retry this exact request or edit its values first.',
        );
      } else {
        setUnknown(false);
        setOperation(null);
        setError(cause instanceof ApiRequestError ? cause.message : 'Agent could not be created.');
      }
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || unknown;
  return (
    <form
      className="agents-create-form"
      aria-labelledby="agents-create-heading"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(unknown);
      }}
    >
      <h3 id="agents-create-heading">Create agent identity</h3>
      <p>
        New identities start as drafts. A profile must be saved and published before assignment.
      </p>
      <div className="agents-create-fields">
        <div className="agents-field">
          <label htmlFor={ids.name}>Name</label>
          <input
            autoFocus
            id={ids.name}
            maxLength={120}
            required
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="agents-field">
          <label htmlFor={ids.slug}>Slug</label>
          <input
            id={ids.slug}
            maxLength={80}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
            value={slug}
            disabled={locked}
            onChange={(event) => setSlug(event.target.value)}
          />
        </div>
      </div>
      {error && (
        <p className="agents-create-error" role="alert">
          {error}
        </p>
      )}
      <div className="agents-create-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        {unknown && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setOperation(null);
              setUnknown(false);
              setError('');
            }}
          >
            Edit values
          </button>
        )}
        <button type="submit" className="primary-button" disabled={busy || !csrfToken}>
          {busy ? 'Creating…' : unknown ? 'Retry same request' : 'Create draft agent'}
        </button>
      </div>
    </form>
  );
}
