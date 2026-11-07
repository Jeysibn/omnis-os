import { useEffect, useMemo, useState } from 'react';
import {
  AgentDirectoryResponseSchema,
  SetTaskExecutionAssignmentSchema,
  TaskSchema,
  type AgentSummary,
  type Task,
} from '@omnis/contracts';
import { ApiRequestError, request } from './api.js';

type PendingAssignment = {
  key: string;
  agentId: string | null;
  profileVersion: number | null;
  runtimeId: 'mock' | null;
  expectedAssignmentRevision: number;
};

export function TaskExecutionAssignmentEditor({
  task,
  csrfToken,
  onTaskUpdated,
  onSessionExpired,
}: {
  task: Task;
  csrfToken: string;
  onTaskUpdated: (task: Task) => void;
  onSessionExpired: (cause: unknown) => boolean;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsState, setAgentsState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [agentId, setAgentId] = useState(task.agentId ?? '');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAssignment | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void request('/api/v1/agents', {}, (value) => AgentDirectoryResponseSchema.parse(value))
      .then((result) => {
        if (!active) return;
        setAgents(
          result.agents.filter((agent) => agent.lifecycle === 'available' && agent.currentVersion),
        );
        setAgentsState('ready');
      })
      .catch((cause: unknown) => {
        if (!active || onSessionExpired(cause)) return;
        setAgentsState('failed');
      });
    return () => {
      active = false;
    };
  }, [onSessionExpired, task.id]);

  useEffect(() => {
    setAgentId(task.agentId ?? '');
    setPending(null);
  }, [task.id, task.agentId, task.profileVersion, task.assignmentRevision]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.id === agentId) ?? null,
    [agents, agentId],
  );
  const selectedProfileVersion = selectedAgent?.currentVersion?.versionNo ?? null;
  const assignmentMatches =
    (task.agentId ?? '') === agentId &&
    (agentId === '' || selectedProfileVersion === task.profileVersion);

  async function save(operation: PendingAssignment) {
    setBusy(true);
    setError('');
    setMessage('');
    setPending(operation);
    try {
      const input = SetTaskExecutionAssignmentSchema.parse({
        agentId: operation.agentId,
        profileVersion: operation.profileVersion,
        runtimeId: operation.runtimeId,
        expectedAssignmentRevision: operation.expectedAssignmentRevision,
      });
      const updated = await request(
        `/api/v1/tasks/${encodeURIComponent(task.id)}/execution-assignment`,
        {
          method: 'PUT',
          headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': operation.key },
          body: JSON.stringify(input),
        },
        (value) => TaskSchema.parse(value),
      );
      onTaskUpdated(updated);
      setAgentId(updated.agentId ?? '');
      setPending(null);
      setMessage('Synthetic mock assignment saved.');
    } catch (cause) {
      if (onSessionExpired(cause)) return;
      const uncertain = cause instanceof ApiRequestError && cause.outcome !== 'rejected';
      setError(
        uncertain
          ? 'The save result is uncertain. Retry the same request to resolve it safely.'
          : cause instanceof Error
            ? cause.message
            : 'The assignment could not be saved.',
      );
      if (!uncertain) setPending(null);
    } finally {
      setBusy(false);
    }
  }

  function submit() {
    if (pending) return void save(pending);
    const nextAgentId = agentId || null;
    const profileVersion = nextAgentId ? selectedProfileVersion : null;
    if (nextAgentId && profileVersion === null) {
      setError('Choose an available agent with a published profile.');
      return;
    }
    void save({
      key: crypto.randomUUID(),
      agentId: nextAgentId,
      profileVersion,
      runtimeId: nextAgentId ? 'mock' : null,
      expectedAssignmentRevision: task.assignmentRevision,
    });
  }

  return (
    <section className="task-assignment" aria-labelledby="task-assignment-heading">
      <h4 id="task-assignment-heading">Execution assignment</h4>
      <p>Choose an available agent profile. Only the synthetic mock runtime is enabled.</p>
      {agentsState === 'loading' ? (
        <p role="status">Loading available agent profiles…</p>
      ) : agentsState === 'failed' ? (
        <p role="status">Agent profiles are unavailable. Retry by reloading this task workspace.</p>
      ) : (
        <>
          <label htmlFor="task-agent-assignment">Agent profile</label>
          <select
            id="task-agent-assignment"
            value={agentId}
            onChange={(event) => {
              setAgentId(event.target.value);
              setMessage('');
              setError('');
            }}
            disabled={busy || pending !== null}
          >
            <option value="">No agent assigned</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} — {agent.currentVersion?.profession} · v
                {agent.currentVersion?.versionNo}
              </option>
            ))}
          </select>
          <label htmlFor="task-runtime-assignment">Runtime</label>
          <select id="task-runtime-assignment" value={agentId ? 'mock' : ''} disabled>
            <option value="">No runtime</option>
            <option value="mock">Synthetic mock runtime</option>
          </select>
          {selectedAgent && (
            <p className="task-assignment-profile">
              Saved profile version: {selectedAgent.currentVersion?.versionNo}. Published profile
              versions are immutable.
            </p>
          )}
          {task.agentId && !selectedAgent && (
            <p className="task-assignment-profile" role="status">
              Saved assignment: {task.agentId} profile v{task.profileVersion}; the agent is no
              longer available for new assignments.
            </p>
          )}
          <button
            className="secondary-button"
            type="button"
            onClick={submit}
            disabled={busy || agentsState !== 'ready' || (assignmentMatches && pending === null)}
          >
            {busy ? 'Saving…' : pending ? 'Retry same save' : 'Save assignment'}
          </button>
          {message && <p role="status">{message}</p>}
          {error && (
            <p className="task-assignment-error" role="alert">
              {error}
            </p>
          )}
          <p className="task-assignment-note">
            Assignment records the chosen immutable profile and synthetic runtime. The current
            “Approve &amp; run” path remains deterministic sandbox work and does not submit profile
            instructions to a model.
          </p>
        </>
      )}
    </section>
  );
}
