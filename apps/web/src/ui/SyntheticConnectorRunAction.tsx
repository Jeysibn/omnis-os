import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
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
const storageVersion = 1 as const;
const pendingOperationStorageKey = 'omnis.synthetic-connector-operation.v1';
type PendingOperation = {
  ownerId: string;
  taskId: string;
  projectId: string;
  profileVersion: number;
  assignmentRevision: number;
  idempotencyKey: string;
  authorizationId: string | null;
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
      storeOperation(nextOperation, ownerId, task.id);
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
    const stored = readOperation(ownerId, task.id);
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
    storeOperation(operation, ownerId, task.id);
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
      clearOperation(ownerId, task.id);
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
          ref={dialogRef}
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

function storageKey(ownerId: string, taskId: string) {
  return `${pendingOperationStorageKey}:${encodeURIComponent(ownerId)}:${encodeURIComponent(taskId)}`;
}

function storeOperation(operation: PendingOperation, ownerId: string, taskId: string) {
  sessionStorage.setItem(
    storageKey(ownerId, taskId),
    JSON.stringify({ version: storageVersion, ...operation }),
  );
}

function clearOperation(ownerId: string, taskId: string) {
  sessionStorage.removeItem(storageKey(ownerId, taskId));
}

function readOperation(ownerId: string, taskId: string): PendingOperation | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey(ownerId, taskId)) ?? 'null',
    );
    if (typeof value !== 'object' || value === null) return null;
    const parsed = pendingOperationSchema.safeParse(value);
    if (!parsed.success) {
      clearOperation(ownerId, taskId);
      return null;
    }
    if (parsed.data.ownerId !== ownerId || parsed.data.taskId !== taskId) {
      clearOperation(ownerId, taskId);
      return null;
    }
    return parsed.data;
  } catch {
    clearOperation(ownerId, taskId);
    return null;
  }
}

const pendingOperationSchema = z
  .object({
    version: z.literal(storageVersion),
    ownerId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    profileVersion: z.number().int().positive(),
    assignmentRevision: z.number().int().positive(),
    idempotencyKey: z.string().uuid(),
    authorizationId: z.string().uuid().nullable(),
  })
  .strict();

function SyntheticOperationDialog({
  ref,
  authorization,
  renderedRequest,
  busy,
  error,
  onApprove,
  onStart,
  onClose,
}: {
  ref: React.RefObject<HTMLDialogElement | null>;
  authorization: ConnectorAuthorization;
  renderedRequest: string;
  busy: boolean;
  error: string;
  onApprove: () => void;
  onStart: () => void;
  onClose: () => void;
}) {
  return (
    <dialog
      ref={ref}
      className="nx-dialog synthetic-operation-dialog"
      aria-labelledby="synthetic-operation-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="nx-dialog__body">
        <h2 id="synthetic-operation-title">Review synthetic operation</h2>
        <p>This is a local deterministic fixture. It cannot contact a real provider.</p>
        <dl className="metadata-list">
          <div>
            <dt>Execution type</dt>
            <dd>Synthetic test fixture</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>mock</dd>
          </div>
          <div>
            <dt>Provider / model</dt>
            <dd>
              {authorization.providerId} / {authorization.modelId}
            </dd>
          </div>
          <div>
            <dt>Operation</dt>
            <dd>{authorization.operation}</dd>
          </div>
          <div>
            <dt>Capabilities</dt>
            <dd>
              {authorization.capabilities.length
                ? authorization.capabilities.join(', ')
                : 'None (text only)'}
            </dd>
          </div>
          <div>
            <dt>Limits</dt>
            <dd>
              {authorization.limits.maxInputTokens} input tokens;{' '}
              {authorization.limits.maxOutputTokens} output tokens;{' '}
              {authorization.limits.maxDurationSeconds}s; {authorization.limits.maxCostMicrousd}{' '}
              micro-USD ceiling
            </dd>
          </div>
          <div>
            <dt>Request digest</dt>
            <dd>
              <code>{authorization.promptDigest}</code>
            </dd>
          </div>
          <div>
            <dt>Approval expires</dt>
            <dd>{new Date(authorization.expiresAt).toLocaleString()}</dd>
          </div>
        </dl>
        <label htmlFor="synthetic-rendered-request">Exact rendered request</label>
        <pre id="synthetic-rendered-request" className="synthetic-request-preview">
          {renderedRequest}
        </pre>
        {error && (
          <p role="alert" className="error-note">
            {error}
          </p>
        )}
        <div className="nx-dialog__actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
            Close
          </button>
          {authorization.status === 'pending' && (
            <button type="button" disabled={busy} onClick={onApprove}>
              Approve exact operation
            </button>
          )}
          {authorization.status === 'authorized' && authorization.consumedAt === null && (
            <button type="button" disabled={busy} onClick={onStart}>
              Start authorized synthetic Run
            </button>
          )}
          {authorization.consumedAt !== null && (
            <p role="status">This authorization was already consumed. Inspect its Run history.</p>
          )}
          {authorization.status !== 'pending' && authorization.status !== 'authorized' && (
            <p role="status">
              This authorization is {authorization.status}; create a new operation to continue.
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}
