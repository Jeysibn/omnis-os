import { useState, type FormEvent } from 'react';
import { ApiRequestError } from '../api.js';
import type { AgentProfileResponse } from '@omnis/contracts';
import { updateAgentIdentity } from './data.js';

export function AgentIdentityEditor({
  profile,
  csrfToken,
  onUnauthorized,
  onSaved,
}: {
  profile: AgentProfileResponse;
  csrfToken: string;
  onUnauthorized: (cause: unknown) => void;
  onSaved: () => void;
}) {
  const { agent } = profile;
  const [name, setName] = useState(agent.name);
  const [slug, setSlug] = useState(agent.slug);
  const [pending, setPending] = useState<{
    requestId: string;
    input: { expectedIdentityRevision: number; name: string; slug: string };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  if (agent.lifecycle === 'archived') return null;
  const dirty = name.trim() !== agent.name || slug !== agent.slug;

  async function save(operation: NonNullable<typeof pending>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await updateAgentIdentity(agent.id, operation.input, csrfToken, operation.requestId);
      setPending(null);
      setMessage('The server confirmed that the agent identity was updated.');
      onSaved();
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        onUnauthorized(cause);
      } else if (cause instanceof ApiRequestError && cause.outcome !== 'rejected') {
        setPending(operation);
        setMessage(
          'The identity update result is unknown. Retry the exact request before editing again.',
        );
      } else {
        setPending(null);
        setMessage(cause instanceof Error ? cause.message : 'The identity was not updated.');
        if (cause instanceof ApiRequestError && cause.status === 409) onSaved();
      }
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedSlug = slug.trim();
    if (!normalizedName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)) {
      setMessage('Enter a name and a lowercase slug with letters, numbers, and single hyphens.');
      return;
    }
    void save({
      requestId: crypto.randomUUID(),
      input: {
        expectedIdentityRevision: agent.identityRevision,
        name: normalizedName,
        slug: normalizedSlug,
      },
    });
  }

  return (
    <form className="agents-profile-editor" onSubmit={submit}>
      <div className="agents-profile-editor-head">
        <h4>Agent identity</h4>
        <p>Name and slug changes do not alter published profile versions.</p>
      </div>
      <div className="agents-identity-editor-fields">
        <label>
          Name
          <input
            value={name}
            maxLength={120}
            disabled={busy || pending !== null}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          Slug
          <input
            value={slug}
            maxLength={80}
            disabled={busy || pending !== null}
            onChange={(event) => setSlug(event.target.value)}
          />
        </label>
      </div>
      <div className="agents-profile-editor-actions">
        <button
          type="submit"
          className="primary-button"
          disabled={busy || pending !== null || !dirty}
        >
          {busy ? 'Saving…' : 'Save identity'}
        </button>
        {pending && (
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void save(pending)}
          >
            Retry same request
          </button>
        )}
      </div>
      {message && <p role={pending ? 'alert' : 'status'}>{message}</p>}
    </form>
  );
}
