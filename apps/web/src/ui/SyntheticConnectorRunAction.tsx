import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AgentProfileVersionResponseSchema,
  RunSchema,
  type ProjectSummary,
  type Run,
  type Task,
} from '@omnis/contracts';
import {
  ConnectorAuthorizationDecisionSchema,
  ConnectorAuthorizationRequestSchema,
  ConnectorAuthorizationSchema,
  CreateConnectorAuthorizationSchema,
} from '@omnis/contracts/connector-authorization-schema';
import type { ConnectorAuthorization } from '@omnis/contracts/connector-authorization-schema';
import {
  clearPendingOperation,
  readPendingOperation,
  storePendingOperation,
  type PendingOperation,
} from './syntheticConnectorOperationStorage.js';
import { SyntheticOperationDialog } from './SyntheticOperationDialog.js';
import { renderSyntheticConnectorRequest } from '@omnis/contracts/synthetic-connector-prompt';
import { RuntimeCapabilitiesSchema } from '@omnis/contracts/runtime-capabilities';
import { ApiRequestError, request } from './api.js';

const limits = {
  maxInputTokens: 100,
  maxOutputTokens: 100,
  maxDurationSeconds: 30,
  maxConcurrentRuns: 1 as const,
  maxUsageUnits: 100,
  maxCostMicrousd: 100,
};
type CapabilityState = 'loading' | 'enabled' | 'disabled' | 'failed';

export function SyntheticConnectorRunAction({
  ownerId,
  task,
  project,
  csrfToken,
  onSessionExpired,
  onRunAdmitted,
}: {
  ownerId: string;
  task: Task;
  project: ProjectSummary | undefined;
  csrfToken: string;
  onSessionExpired: (cause: unknown) => boolean;
  onRunAdmitted: (run: Run) => void;
}) {
  const [availability, setAvailability] = useState<CapabilityState>('loading');
  const [authorization, setAuthorization] = useState<ConnectorAuthorization | null>(null);
  const [renderedRequest, setRenderedRequest] = useState('');
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  const canRun = Boolean(
    task.projectId &&
    project?.id === task.projectId &&
    project.status === 'active' &&
    task.agentId &&
    task.profileVersion &&
    task.runtimeId === 'mock' &&
    task.status !== 'completed',
  );

  const handleError = useCallback(
    (cause: unknown, fallback: string) => {
      if (!onSessionExpired(cause)) {
        setError(cause instanceof Error ? cause.message : fallback);
      }
    },
    [onSessionExpired],
  );

  const loadRequest = useCallback(
    async (operation: PendingOperation) => {
      const profile = await request(
        `/api/v1/agents/${encodeURIComponent(task.agentId!)}/versions/${operation.profileVersion}`,
        {},
        (value) => {
          const result = AgentProfileVersionResponseSchema.parse(value);
          if (
            result.agent.id !== task.agentId ||
            result.version.agentId !== task.agentId ||
            result.version.versionNo !== operation.profileVersion
          )
            throw new Error('The immutable agent profile response did not match this task.');
          return result.version;
        },
      );
      const rendered = renderSyntheticConnectorRequest(task, profile);
      const input = CreateConnectorAuthorizationSchema.parse({
        projectId: project!.id,
        projectRevision: project!.revision,
        taskId: task.id,
        taskRevision: task.associationRevision,
        agentId: task.agentId,
        profileVersion: operation.profileVersion,
        connectorId: 'synthetic.codex.fixture',
        connectorVersion: '0.0.0-synthetic.1',
        providerId: 'synthetic',
        modelId: 'synthetic-text-only-v1',
        operation: 'connector.respond',
        capabilities: [],
        limits,
        renderedRequest: rendered,
      });
      return { rendered, input };
    },
    [project, task],
  );

  const createOrReadAuthorization = useCallback(
    async (operation: PendingOperation) => {
      const { rendered, input } = await loadRequest(operation);
      let grant: ConnectorAuthorization;
      if (operation.authorizationId) {
        try {
          grant = await request(
            `/api/v1/connector-authorizations/${encodeURIComponent(operation.authorizationId)}`,
            {},
            (value) => ConnectorAuthorizationSchema.parse(value),
          );
        } catch (cause) {
          if (!(cause instanceof ApiRequestError) || cause.status !== 404) throw cause;
          grant = await createAuthorization(operation, input, csrfToken);
        }
      } else {
        grant = await createAuthorization(operation, input, csrfToken);
      }
      const expectedBinding = Object.fromEntries(
        Object.entries(input).filter(([key]) => key !== 'renderedRequest'),
      );
      const bindingMatches = Object.entries(expectedBinding).every(
        ([key, value]) =>
          JSON.stringify(grant[key as keyof ConnectorAuthorization]) === JSON.stringify(value),
      );
      if (
        grant.requestId !== operation.idempotencyKey ||
        grant.taskId !== task.id ||
        grant.projectId !== project?.id ||
        grant.agentId !== task.agentId ||
        grant.profileVersion !== operation.profileVersion ||
        grant.synthetic !== true ||
        !bindingMatches
      ) {
        throw new Error('The persisted authorization did not match the exact synthetic operation.');
      }
      const nextOperation = { ...operation, authorizationId: grant.id };
      storePendingOperation(nextOperation, ownerId, task.id);
      setPendingOperation(nextOperation);
      setRenderedRequest(rendered);
      setAuthorization(grant);
      setDialogOpen(true);
      setError('');
      return grant;
    },
    [csrfToken, loadRequest, ownerId, project?.id, task],
  );

  useEffect(() => {
    let active = true;
    void request('/api/v1/runtime-capabilities', {}, (value) =>
      RuntimeCapabilitiesSchema.parse(value),
    )
      .then((value) => {
        if (!active) return;
        setAvailability(value.syntheticConnectorFixture.enabled ? 'enabled' : 'disabled');
      })
      .catch((cause: unknown) => {
        if (!active || onSessionExpired(cause)) return;
        setAvailability('failed');
      });
    return () => {
      active = false;
    };
  }, [onSessionExpired, task.id]);

  useEffect(() => {
    if (!dialogOpen) return;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [dialogOpen]);

  useEffect(() => {
    if (availability !== 'enabled' || !canRun || pendingOperation) return;
    const stored = readPendingOperation(ownerId, task.id);
    if (
      stored &&
      stored.ownerId === ownerId &&
      stored.taskId === task.id &&
      stored.projectId === project?.id &&
      stored.profileVersion === task.profileVersion &&
      stored.assignmentRevision === task.assignmentRevision
    ) {
      setPendingOperation(stored);
      void createOrReadAuthorization(stored).catch((cause: unknown) =>
        handleError(cause, 'The pending synthetic operation could not be recovered.'),
      );
    }
  }, [
    availability,
    canRun,
    createOrReadAuthorization,
    handleError,
    ownerId,
    pendingOperation,
    project?.id,
    task.assignmentRevision,
    task.id,
    task.profileVersion,
  ]);

  async function prepare() {
    if (!canRun || !task.projectId || !task.agentId || !task.profileVersion) return;
    setBusy(true);
    setError('');
    const operation: PendingOperation = {
      ownerId,
      taskId: task.id,
      projectId: task.projectId,
      profileVersion: task.profileVersion,
      assignmentRevision: task.assignmentRevision,
      idempotencyKey: crypto.randomUUID(),
      authorizationId: null,
    };
    storePendingOperation(operation, ownerId, task.id);
    setPendingOperation(operation);
    try {
      await createOrReadAuthorization(operation);
    } catch (cause) {
      handleError(cause, 'The synthetic operation could not be prepared.');
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!authorization || authorization.status !== 'pending') return;
    setBusy(true);
    setError('');
    try {
      const decision = ConnectorAuthorizationDecisionSchema.parse({
        decision: 'approve',
        promptDigestConfirmation: authorization.promptDigest,
      });
      const approved = await request(
        `/api/v1/connector-authorizations/${encodeURIComponent(authorization.id)}/decision`,
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken },
          body: JSON.stringify(decision),
        },
        (value) => ConnectorAuthorizationSchema.parse(value),
      );
      if (
        approved.id !== authorization.id ||
        approved.requestId !== authorization.requestId ||
        approved.promptDigest !== authorization.promptDigest ||
        approved.status !== 'authorized' ||
        approved.decidedBy !== 'owner'
      )
        throw new Error('Omnis OS did not confirm this exact owner-approved operation.');
      setAuthorization(approved);
      setAnnouncement('Exact synthetic operation approved. No run has started yet.');
    } catch (cause) {
      handleError(cause, 'The synthetic operation could not be approved.');
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    if (!authorization || authorization.status !== 'authorized' || !renderedRequest) return;
    setBusy(true);
    setError('');
    try {
      const requestBinding = ConnectorAuthorizationRequestSchema.parse({
        projectId: authorization.projectId,
        projectRevision: authorization.projectRevision,
        taskId: authorization.taskId,
        taskRevision: authorization.taskRevision,
        agentId: authorization.agentId,
        profileVersion: authorization.profileVersion,
        connectorId: authorization.connectorId,
        connectorVersion: authorization.connectorVersion,
        providerId: authorization.providerId,
        modelId: authorization.modelId,
        operation: authorization.operation,
        capabilities: authorization.capabilities,
        limits: authorization.limits,
        promptDigest: authorization.promptDigest,
      });
      const run = await request(
        `/api/v1/tasks/${encodeURIComponent(task.id)}/synthetic-runs`,
        {
          method: 'POST',
          headers: {
            'x-omnis-csrf': csrfToken,
            'idempotency-key': authorization.requestId,
          },
          body: JSON.stringify({
            authorizationId: authorization.id,
            request: requestBinding,
            renderedRequest,
          }),
        },
        (value) => RunSchema.parse(value),
      );
      if (run.id !== authorization.correlationId || run.taskId !== task.id) {
        throw new Error('The admitted Run did not match its approved task and correlation.');
      }
      clearPendingOperation(ownerId, task.id);
      onRunAdmitted(run);
    } catch (cause) {
      handleError(cause, 'The authorized synthetic Run could not be started.');
    } finally {
      setBusy(false);
    }
  }

  function closeDialog() {
    if (busy) return;
    setDialogOpen(false);
  }

  if (availability === 'disabled') return null;
  return (
    <section className="synthetic-connector-action" aria-labelledby="synthetic-connector-heading">
      <h4 id="synthetic-connector-heading">Synthetic connector fixture</h4>
      <p>Test-only local fake provider. It cannot contact a real inference service.</p>
      {availability === 'loading' ? (
        <p role="status">Checking available synthetic runtimes…</p>
      ) : availability === 'failed' ? (
        <p role="status">Runtime availability is unknown. Reload to check again.</p>
      ) : (
        <>
          {!canRun && (
            <p>
              Assign this task to an active project, published agent profile, and mock runtime
              first.
            </p>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={!canRun || busy}
            onClick={() => void prepare()}
          >
            {busy
              ? 'Preparing exact operation…'
              : pendingOperation
                ? 'Resume operation review'
                : 'Review synthetic operation'}
          </button>
          {announcement && <p role="status">{announcement}</p>}
          {error && (
            <p role="alert" className="error-note">
              {error}
            </p>
          )}
        </>
      )}
      {dialogOpen && authorization && (
        <SyntheticOperationDialog
          dialogRef={dialogRef}
          authorization={authorization}
          renderedRequest={renderedRequest}
          busy={busy}
          error={error}
          onApprove={() => void approve()}
          onStart={() => void startRun()}
          onClose={closeDialog}
        />
      )}
    </section>
  );
}

async function createAuthorization(operation: PendingOperation, input: unknown, csrfToken: string) {
  return request(
    '/api/v1/connector-authorizations',
    {
      method: 'POST',
      headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': operation.idempotencyKey },
      body: JSON.stringify(input),
    },
    (value) => ConnectorAuthorizationSchema.parse(value),
  );
}
