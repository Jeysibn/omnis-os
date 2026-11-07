import { useRef, useState } from 'react';
import type { AgentProfileResponse } from '@omnis/contracts';
import { ConfirmDialog, NxTheme } from '../design/index.js';
import { ApiRequestError } from '../api.js';
import { archiveAgent, fetchProfile } from './data.js';

export function AgentArchiveAction({
  profile,
  csrfToken,
  onUnauthorized,
  onArchived,
}: {
  profile: AgentProfileResponse;
  csrfToken: string;
  onUnauthorized: (cause: unknown) => void;
  onArchived: () => void;
}) {
  const { agent } = profile;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [message, setMessage] = useState('');
  const requestId = useRef<string | null>(null);
  const inflight = useRef(false);

  if (agent.lifecycle !== 'available') return null;

  async function archive(key: string) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setMessage('');
    try {
      await archiveAgent(agent.id, key, csrfToken);
      requestId.current = null;
      setUnknown(false);
      setMessage('The server confirmed that the agent was archived.');
      onArchived();
    } catch (cause) {
      if (cause instanceof ApiRequestError && cause.status === 401) {
        onUnauthorized(cause);
        return;
      }
      if (cause instanceof ApiRequestError && cause.outcome === 'rejected') {
        requestId.current = null;
        setUnknown(false);
        setMessage(cause.message);
        return;
      }

      requestId.current = key;
      try {
        const current = await fetchProfile(agent.id, new AbortController().signal);
        if (current.agent.lifecycle === 'archived') {
          requestId.current = null;
          setUnknown(false);
          setMessage('The server confirms that the agent is archived.');
          onArchived();
          return;
        }
      } catch (readCause) {
        if (readCause instanceof ApiRequestError && readCause.status === 401) {
          onUnauthorized(readCause);
          return;
        }
      }
      setUnknown(true);
      setMessage('The archive result is unknown. Check the profile or retry the same request.');
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  function confirmArchive() {
    setConfirmOpen(false);
    const key = requestId.current ?? crypto.randomUUID();
    requestId.current = key;
    void archive(key);
  }

  return (
    <div className="agents-archive-action">
      <button
        type="button"
        className="secondary-button"
        disabled={busy || unknown}
        onClick={() => setConfirmOpen(true)}
      >
        Archive agent
      </button>
      {message && (
        <p role={unknown ? 'alert' : 'status'}>
          {message}{' '}
          {unknown && requestId.current && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                const key = requestId.current;
                if (key) void archive(key);
              }}
            >
              Retry same request
            </button>
          )}
        </p>
      )}
      <NxTheme>
        <ConfirmDialog
          open={confirmOpen}
          danger
          title="Archive this agent?"
          description={`Archiving “${agent.name}” cannot be undone. There is no restore action. Profile history is preserved, but this agent can't be assigned new work. Existing run history is not changed.`}
          confirmLabel="Archive agent"
          onCancel={() => setConfirmOpen(false)}
          onConfirm={confirmArchive}
        />
      </NxTheme>
    </div>
  );
}
