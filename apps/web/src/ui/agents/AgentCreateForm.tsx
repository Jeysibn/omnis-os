import { useId, useState } from 'react';
import {
  AgentIdempotencyKeySchema,
  AgentMutationReceiptSchema,
  CreateAgentInputSchema,
  type CreateAgentInput,
} from '@omnis/contracts';
import { ApiRequestError, request } from '../api.js';
import { AgentDepartmentSelect } from './AgentDepartmentSelect.js';
import { profileHash } from './route.js';

type Operation = { input: CreateAgentInput; key: string };
const pendingStorageKey = 'omnis.agent-create.pending.v1';

function restorePendingOperation(): Operation | null {
  try {
    const raw = sessionStorage.getItem(pendingStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (Object.keys(value).length !== 2 || !('input' in value) || !('key' in value)) {
      sessionStorage.removeItem(pendingStorageKey);
      return null;
    }
    const input = CreateAgentInputSchema.safeParse(value.input);
    const key = AgentIdempotencyKeySchema.safeParse(value.key);
    if (!input.success || !key.success) {
      sessionStorage.removeItem(pendingStorageKey);
      return null;
    }
    return { input: input.data, key: key.data };
  } catch {
    return null;
  }
}

function clearPendingOperation() {
  try {
    sessionStorage.removeItem(pendingStorageKey);
  } catch {
    // The operation state will still be discarded locally; storage cleanup is best effort.
  }
}

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
  const [operation, setOperation] = useState<Operation | null>(restorePendingOperation);
  const [name, setName] = useState(() => operation?.input.name ?? '');
  const [slug, setSlug] = useState(() => operation?.input.slug ?? '');
  const [departmentId, setDepartmentId] = useState<string | null>(
    () => operation?.input.departmentId ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(() => operation !== null);
  const [error, setError] = useState(() =>
    operation
      ? 'The create result is unknown. Retry this exact request before starting another.'
      : '',
  );
  async function submit(retry = false) {
    setError('');
    const parsed = CreateAgentInputSchema.safeParse({
      name,
      slug,
      departmentId,
    });
    if (!parsed.success) {
      setError('Enter a name and a lowercase slug using letters, numbers, and single hyphens.');
      return;
    }
    const current =
      retry && operation ? operation : { input: parsed.data, key: crypto.randomUUID() };
    try {
      sessionStorage.setItem(pendingStorageKey, JSON.stringify(current));
    } catch {
      setError('This tab cannot preserve a safe retry, so agent creation is paused.');
      return;
    }
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
        (value) => {
          const result = AgentMutationReceiptSchema.parse(value);
          if (
            result.requestId !== current.key ||
            result.operation !== 'agent.created' ||
            result.lifecycle !== 'draft'
          )
            throw new Error('Create receipt does not match the submitted request.');
          return result;
        },
      );
      clearPendingOperation();
      window.location.hash = profileHash(receipt.agentId);
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        if (!unknown) {
          clearPendingOperation();
          setOperation(null);
          setUnknown(false);
        }
        onUnauthorized(cause);
      } else if (cause instanceof ApiRequestError && cause.outcome !== 'rejected') {
        setUnknown(true);
        setError('The create result is unknown. Retry this exact request before starting another.');
      } else {
        clearPendingOperation();
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
        <AgentDepartmentSelect
          value={departmentId}
          pendingDepartmentId={operation?.input.departmentId ?? null}
          disabled={locked}
          onChange={setDepartmentId}
          onUnauthorized={onUnauthorized}
        />
      </div>
      {error && (
        <p className="agents-create-error" role="alert">
          {error}
        </p>
      )}
      <div className="agents-create-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={busy || unknown}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={busy || !csrfToken}>
          {busy ? 'Creating…' : unknown ? 'Retry same request' : 'Create draft agent'}
        </button>
      </div>
    </form>
  );
}
