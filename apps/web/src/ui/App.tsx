import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CircleStop,
  Clock3,
  Command,
  FilePlus2,
  FolderKanban,
  ListChecks,
  LockKeyhole,
  LogOut,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  AuthorizationSchema,
  RunEventSchema,
  RunSchema,
  TaskSchema,
  type Authorization,
  type Run,
  type RunEvent,
  type Task,
} from '@omnis/contracts';
import { ApiRequestError, request } from './api.js';
import { AgentsWorkspace } from './agents/AgentsWorkspace.js';

// The cinematic renderer is isolated in its own chunk and only loads on the Command Center route.
const NexusCommandCenter = lazy(() => import('./nexus/NexusCommandCenter.js'));

type Owner = { id: string; displayName: string };
type Page = 'command-center' | 'tasks' | 'runs' | 'agents';
type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'ended';
type ApprovalOperation = {
  taskId: string;
  authorizationKey: string;
  runKey: string;
  authorization: Authorization | null;
  canRetry: boolean;
  authorizationUncertain: boolean;
  decisionUncertain: boolean;
  runUncertain: boolean;
};

const parseOwner = (value: unknown): Owner => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !('displayName' in value) ||
    typeof value.displayName !== 'string' ||
    value.displayName.length === 0
  ) {
    throw new Error('Owner session response is invalid.');
  }
  return { id: value.id, displayName: value.displayName };
};

const parseTaskList = (value: unknown): Task[] => {
  if (!Array.isArray(value)) throw new Error('Task list response is invalid.');
  return value.map((item) => TaskSchema.parse(item));
};

const parseRunList = (value: unknown): Run[] => {
  if (!Array.isArray(value)) throw new Error('Run list response is invalid.');
  return value.map((item) => RunSchema.parse(item));
};

const isActive = (status: Run['status']) => ['queued', 'running', 'stopping'].includes(status);
const terminalStatus = (type: RunEvent['type']): Run['status'] | null => {
  switch (type) {
    case 'run.completed':
      return 'completed';
    case 'run.cancelled':
      return 'cancelled';
    case 'run.failed':
      return 'failed';
    case 'run.interrupted':
      return 'interrupted';
    default:
      return null;
  }
};
const statusForEvent = (type: RunEvent['type']): Run['status'] => {
  const terminal = terminalStatus(type);
  if (terminal) return terminal;
  if (type === 'run.stop_requested') return 'stopping';
  if (type === 'run.queued') return 'queued';
  return 'running';
};
const failureMessage = (cause: unknown, fallback: string) =>
  cause instanceof ApiRequestError ? cause.message : fallback;

function authorizationScopeError(authorization: Authorization, task: Task): string | null {
  if (
    authorization.requestingActor !== 'owner' ||
    authorization.runtimeId !== 'mock' ||
    authorization.operation !== 'execute_task'
  ) {
    return 'The approval did not come from the expected owner mock-execution flow.';
  }
  if (
    authorization.taskId !== task.id ||
    authorization.scope.kind !== 'task' ||
    authorization.scope.taskId !== task.id
  ) {
    return 'The approval is scoped to a different task.';
  }
  if (!authorization.capabilities.includes('mock.execute')) {
    return 'The approval does not grant the mock execution capability.';
  }
  if (Date.parse(authorization.expiresAt) <= Date.now()) {
    return 'The approval has expired.';
  }
  if (
    authorization.status === 'authorized' &&
    (authorization.decidedBy !== 'owner' || authorization.decidedAt === null)
  ) {
    return 'The owner approval is missing a confirmed decision.';
  }
  if (authorization.consumedAt !== null || authorization.consumedRunId !== null) {
    return 'The approval has already been consumed.';
  }
  return null;
}

function statusLabel(status: Run['status'] | Task['status']): string {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string, options: Intl.DateTimeFormatOptions = {}) {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(new Date(value));
}

function App() {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [checking, setChecking] = useState(true);
  const [csrfToken, setCsrfToken] = useState('');
  const [csrfLoading, setCsrfLoading] = useState(false);
  const [csrfBootstrapError, setCsrfBootstrapError] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [tasksError, setTasksError] = useState('');
  const [runsError, setRunsError] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [page, setPage] = useState<Page>(() => readRoute().page);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [password, setPassword] = useState('');
  const [approvalTask, setApprovalTask] = useState<Task | null>(null);
  const [approvalOperation, setApprovalOperation] = useState<ApprovalOperation | null>(null);
  const [approvalExpiry, setApprovalExpiry] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reconcileError, setReconcileError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const approvalTrigger = useRef<HTMLButtonElement | null>(null);
  const focusRunInspector = useRef(false);
  const sessionRecoveryInFlight = useRef(false);
  const stopInFlight = useRef(new Set<string>());
  const seenSequences = useRef(new Map<string, Set<number>>());

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const selectedRunExists = selectedRun !== null;
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const refreshCsrf = useCallback(async () => {
    setCsrfLoading(true);
    setCsrfBootstrapError('');
    try {
      const value = await request('/api/v1/auth/csrf', {}, (payload) => {
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('csrfToken' in payload) ||
          typeof payload.csrfToken !== 'string' ||
          payload.csrfToken.length === 0
        )
          throw new Error('Secure sign-in setup returned an invalid token.');
        return payload.csrfToken;
      });
      setCsrfToken(value);
      return value;
    } catch (cause) {
      setCsrfToken('');
      setCsrfBootstrapError(
        'Secure sign-in could not be prepared. Check your connection and retry secure sign-in setup.',
      );
      throw cause;
    } finally {
      setCsrfLoading(false);
    }
  }, []);

  const expireSessionIfNeeded = useCallback(
    (cause: unknown) => {
      if (!(cause instanceof ApiRequestError) || cause.status !== 401) return false;
      setOwner(null);
      setCsrfToken('');
      setTasks([]);
      setRuns([]);
      setSelectedRunId(null);
      setSelectedTaskId(null);
      setEvents([]);
      setApprovalTask(null);
      setApprovalOperation(null);
      setApprovalExpiry('');
      setPassword('');
      setError('Your owner session expired. Sign in again to continue.');
      setCsrfBootstrapError('');
      if (!sessionRecoveryInFlight.current) {
        sessionRecoveryInFlight.current = true;
        void refreshCsrf()
          .catch(() => undefined)
          .finally(() => {
            sessionRecoveryInFlight.current = false;
          });
      }
      return true;
    },
    [refreshCsrf],
  );

  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError('');
    try {
      const taskData = await request('/api/v1/tasks', {}, parseTaskList);
      setTasks(taskData);
      setSelectedTaskId((current) =>
        current && taskData.some((task) => task.id === current)
          ? current
          : (taskData[0]?.id ?? null),
      );
    } catch (cause) {
      if (!expireSessionIfNeeded(cause))
        setTasksError(failureMessage(cause, 'Tasks could not be loaded.'));
    } finally {
      setTasksLoading(false);
    }
  }, [expireSessionIfNeeded]);

  const loadRuns = useCallback(async () => {
    setRunsLoading(true);
    setRunsError('');
    try {
      const runData = await request('/api/v1/runs', {}, parseRunList);
      setRuns(runData);
      setSelectedRunId((current) => {
        const requestedRunId = readRunId();
        if (requestedRunId) return requestedRunId;
        return current && runData.some((run) => run.id === current)
          ? current
          : (runData[0]?.id ?? null);
      });
    } catch (cause) {
      if (!expireSessionIfNeeded(cause))
        setRunsError(failureMessage(cause, 'Runs could not be loaded.'));
    } finally {
      setRunsLoading(false);
    }
  }, [expireSessionIfNeeded]);

  const loadWorkspace = useCallback(async () => {
    await Promise.all([loadTasks(), loadRuns()]);
  }, [loadRuns, loadTasks]);

  const reconcileRun = useCallback(
    async (runId: string) => {
      setReconcileError('');
      try {
        const run = await request(`/api/v1/runs/${encodeURIComponent(runId)}`, {}, (value) =>
          RunSchema.parse(value),
        );
        setRuns((current) => current.map((entry) => (entry.id === run.id ? run : entry)));
      } catch (cause) {
        if (!expireSessionIfNeeded(cause)) {
          setReconcileError(failureMessage(cause, 'The final run state could not be confirmed.'));
        }
      }
    },
    [expireSessionIfNeeded],
  );

  useEffect(() => {
    const onHashChange = () => {
      const route = readRoute();
      setPage(route.page);
      if (route.page === 'runs') setSelectedRunId(route.runId ?? null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    if (!focusRunInspector.current || page !== 'runs' || !selectedRunId) return;
    window.requestAnimationFrame(() => {
      document.getElementById('run-inspector-heading')?.focus();
      focusRunInspector.current = false;
    });
  }, [page, selectedRunId]);

  useEffect(() => {
    void (async () => {
      try {
        await refreshCsrf();
        const currentOwner = await request('/api/v1/me', {}, parseOwner);
        setOwner(currentOwner);
        setChecking(false);
        void loadWorkspace();
      } catch (cause) {
        if (!(cause instanceof ApiRequestError && cause.status === 401)) {
          setError(failureMessage(cause, 'Omnis OS could not open this workspace.'));
        }
      } finally {
        setChecking(false);
      }
    })();
  }, [loadWorkspace, refreshCsrf]);

  useEffect(() => {
    if (!owner || page !== 'runs' || !selectedRunId || !selectedRunExists) {
      setEvents([]);
      setStreamState('closed');
      return;
    }
    setEvents([]);
    setReconcileError('');
    setAnnouncement('');
    seenSequences.current.set(selectedRunId, new Set());
    setStreamState('connecting');
    let terminalHandled = false;
    const source = new EventSource(`/api/v1/runs/${encodeURIComponent(selectedRunId)}/events`);
    const eventNames = [
      'run.queued',
      'run.started',
      'run.output',
      'run.stop_requested',
      'run.completed',
      'run.cancelled',
      'run.failed',
      'run.interrupted',
    ];
    source.onopen = () => setStreamState('connected');
    const handlers = eventNames.map((name) => {
      const handler = (message: Event) => {
        try {
          const eventMessage = message as MessageEvent<string>;
          const parsed = RunEventSchema.parse(JSON.parse(eventMessage.data));
          if (
            parsed.runId !== selectedRunId ||
            parsed.type !== name ||
            eventMessage.lastEventId !== String(parsed.sequence)
          ) {
            throw new Error('The event stream cursor or run identity did not match its event.');
          }
          const received = seenSequences.current.get(selectedRunId) ?? new Set<number>();
          if (received.has(parsed.sequence)) return;
          const newestSequence = Math.max(0, ...received);
          received.add(parsed.sequence);
          seenSequences.current.set(selectedRunId, received);
          setEvents((current) => [...current, parsed].sort((a, b) => a.sequence - b.sequence));
          if (parsed.sequence > newestSequence) {
            const status = statusForEvent(parsed.type);
            setRuns((current) =>
              current.map((run) =>
                run.id === selectedRunId ? { ...run, status, updatedAt: parsed.at } : run,
              ),
            );
          }
          if (
            [
              'run.queued',
              'run.started',
              'run.stop_requested',
              'run.completed',
              'run.cancelled',
              'run.failed',
              'run.interrupted',
            ].includes(parsed.type)
          ) {
            setAnnouncement(
              `${parsed.type.replace('run.', '').replaceAll('_', ' ')}: ${parsed.message}`,
            );
          }
          if (parsed.sequence > newestSequence && terminalStatus(parsed.type) && !terminalHandled) {
            terminalHandled = true;
            setStreamState('ended');
            source.close();
            void reconcileRun(selectedRunId);
          }
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : 'A run event did not match its contract.',
          );
        }
      };
      source.addEventListener(name, handler);
      return [name, handler] as const;
    });
    source.onerror = () => {
      if (!terminalHandled)
        setStreamState(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };
    return () => {
      handlers.forEach(([name, handler]) => source.removeEventListener(name, handler));
      source.close();
    };
  }, [owner, page, reconcileRun, selectedRunExists, selectedRunId]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request(
        '/api/v1/auth/login',
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken },
          body: JSON.stringify({ password }),
        },
        (value) => value,
      );
      setPassword('');
      const token = await refreshCsrf();
      const currentOwner = await request('/api/v1/me', {}, parseOwner);
      setOwner(currentOwner);
      setCsrfToken(token);
      await loadWorkspace();
    } catch (cause) {
      setError(failureMessage(cause, 'Sign in could not be completed.'));
    } finally {
      setBusy(false);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const task = await request(
        '/api/v1/tasks',
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken },
          body: JSON.stringify({ title, detail }),
        },
        (value) => TaskSchema.parse(value),
      );
      setTasks((current) => [task, ...current]);
      setSelectedTaskId(task.id);
      setTitle('');
      setDetail('');
    } catch (cause) {
      if (!expireSessionIfNeeded(cause)) {
        setError(
          cause instanceof ApiRequestError && cause.outcome !== 'rejected'
            ? 'Task creation could not be confirmed. Reload Tasks and check for the task before trying again.'
            : failureMessage(cause, 'Task could not be created.'),
        );
      }
    } finally {
      setBusy(false);
    }
  }

  function openApproval(task: Task, trigger: HTMLButtonElement) {
    approvalTrigger.current = trigger;
    setApprovalError('');
    setApprovalExpiry('');
    setApprovalOperation({
      taskId: task.id,
      authorizationKey: crypto.randomUUID(),
      runKey: crypto.randomUUID(),
      authorization: null,
      canRetry: true,
      authorizationUncertain: false,
      decisionUncertain: false,
      runUncertain: false,
    });
    setApprovalTask(task);
  }

  function closeApproval() {
    if (busy) return;
    setApprovalTask(null);
    setApprovalOperation(null);
    setApprovalError('');
    window.requestAnimationFrame(() => {
      if (approvalTrigger.current?.isConnected) approvalTrigger.current.focus();
    });
  }

  async function startRun(task: Task) {
    let operation = approvalOperation;
    if (!operation || operation.taskId !== task.id) {
      setApprovalError('This approval request is no longer available. Close it and start again.');
      return;
    }
    setBusy(true);
    setError('');
    setApprovalError('');
    try {
      let authorization = operation.authorization;
      let requestedAuthorizationId = authorization?.id ?? null;
      if (!authorization) {
        try {
          authorization = await request(
            '/api/v1/authorizations',
            {
              method: 'POST',
              headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': operation.authorizationKey },
              body: JSON.stringify({ taskId: task.id }),
            },
            (value) => AuthorizationSchema.parse(value),
          );
        } catch (cause) {
          if (expireSessionIfNeeded(cause)) return;
          if (cause instanceof ApiRequestError && cause.outcome !== 'rejected') {
            operation = { ...operation, authorizationUncertain: true };
            setApprovalOperation(operation);
            setApprovalError(
              'The approval request may have reached Omnis OS, but its result was not confirmed. Retry this same request to safely reconcile it.',
            );
          } else {
            operation = { ...operation, canRetry: false };
            setApprovalOperation(operation);
            setApprovalError(
              failureMessage(cause, 'Omnis OS could not create the approval request.'),
            );
          }
          return;
        }
        if (authorization.status !== 'pending' || authorizationScopeError(authorization, task)) {
          operation = { ...operation, authorization, canRetry: false };
          setApprovalOperation(operation);
          setApprovalError(
            authorizationScopeError(authorization, task) ??
              `Omnis OS returned an unexpected ${authorization.status} approval. No run was requested.`,
          );
          return;
        }
        operation = { ...operation, authorization, authorizationUncertain: false };
        setApprovalOperation(operation);
        setApprovalExpiry(authorization.expiresAt);
      }
      requestedAuthorizationId = authorization.id;

      if (operation.decisionUncertain) {
        setApprovalError(
          'The owner approval result is uncertain. The API has no authorization lookup route, so this decision cannot be safely repeated and no run was requested. Close this dialog and review the authorization record before proceeding.',
        );
        return;
      }

      if (authorization.status === 'pending') {
        try {
          authorization = await request(
            `/api/v1/authorizations/${encodeURIComponent(authorization.id)}/decision`,
            {
              method: 'POST',
              headers: { 'x-omnis-csrf': csrfToken },
              body: JSON.stringify({ decision: 'approve' }),
            },
            (value) => AuthorizationSchema.parse(value),
          );
        } catch (cause) {
          if (expireSessionIfNeeded(cause)) return;
          if (cause instanceof ApiRequestError && cause.outcome !== 'rejected') {
            operation = { ...operation, authorization, decisionUncertain: true };
            setApprovalOperation(operation);
            setApprovalError(
              'The approval decision may have been recorded, but the response was lost. No run was requested. The API cannot look up this decision, so do not repeat it.',
            );
          } else {
            setApprovalError(
              failureMessage(cause, 'Omnis OS could not record the approval decision.'),
            );
          }
          return;
        }
        operation = { ...operation, authorization };
        setApprovalOperation(operation);
        setApprovalExpiry(authorization.expiresAt);
      }

      if (authorization.status !== 'authorized') {
        operation = { ...operation, authorization, canRetry: false };
        setApprovalOperation(operation);
        setApprovalError(`Authorization is ${authorization.status}; no run was requested.`);
        return;
      }
      if (requestedAuthorizationId && authorization.id !== requestedAuthorizationId) {
        operation = { ...operation, authorization, canRetry: false };
        setApprovalOperation(operation);
        setApprovalError(
          'The authorization identity changed during approval. No run was requested.',
        );
        return;
      }
      const scopeError = authorizationScopeError(authorization, task);
      if (scopeError) {
        operation = { ...operation, authorization, canRetry: false };
        setApprovalOperation(operation);
        setApprovalError(`${scopeError} No run was requested.`);
        return;
      }

      let run: Run;
      try {
        run = await request(
          '/api/v1/runs',
          {
            method: 'POST',
            headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': operation.runKey },
            body: JSON.stringify({ taskId: task.id, authorizationId: authorization.id }),
          },
          (value) => RunSchema.parse(value),
        );
      } catch (cause) {
        if (expireSessionIfNeeded(cause)) return;
        if (cause instanceof ApiRequestError && cause.outcome !== 'rejected') {
          operation = { ...operation, runUncertain: true };
          setApprovalOperation(operation);
          setApprovalError(
            'The run request may have been accepted, but its response was not confirmed. Retry with the same request key to reconcile it safely.',
          );
          return;
        }
        let revokeMessage = '';
        if (authorization.consumedAt === null && authorization.consumedRunId === null) {
          try {
            const revoked = await request(
              `/api/v1/authorizations/${encodeURIComponent(authorization.id)}/revoke`,
              { method: 'POST', headers: { 'x-omnis-csrf': csrfToken } },
              (value) => AuthorizationSchema.parse(value),
            );
            revokeMessage =
              revoked.id === authorization.id &&
              revoked.status === 'revoked' &&
              revoked.consumedAt === null &&
              revoked.consumedRunId === null
                ? ' The unused approval was revoked.'
                : ' Omnis OS could not confirm revocation; review the authorization before another attempt.';
          } catch {
            revokeMessage =
              ' Omnis OS could not confirm revocation; review the authorization before another attempt.';
          }
        }
        operation = { ...operation, canRetry: false };
        setApprovalOperation(operation);
        setApprovalError(
          `${failureMessage(cause, 'Omnis OS rejected the run request.')}${revokeMessage}`,
        );
        return;
      }

      setRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)]);
      setSelectedRunId(run.id);
      setEvents([]);
      setPage('runs');
      navigate('runs', setPage, run.id);
      setApprovalTask(null);
      setApprovalOperation(null);
      setApprovalExpiry('');
      focusRunInspector.current = true;
      void loadRuns();
    } catch (cause) {
      if (!expireSessionIfNeeded(cause))
        setApprovalError(failureMessage(cause, 'Omnis OS could not start this mock run.'));
    } finally {
      setBusy(false);
    }
  }

  async function stopRun(run: Run) {
    if (stopInFlight.current.has(run.id)) return;
    stopInFlight.current.add(run.id);
    setBusy(true);
    setError('');
    try {
      const updated = await request(
        `/api/v1/runs/${encodeURIComponent(run.id)}/stop`,
        { method: 'POST', headers: { 'x-omnis-csrf': csrfToken } },
        (value) => RunSchema.parse(value),
      );
      setRuns((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (cause) {
      if (!expireSessionIfNeeded(cause))
        setError(failureMessage(cause, 'Omnis OS could not stop this run.'));
    } finally {
      stopInFlight.current.delete(run.id);
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await request(
        '/api/v1/auth/logout',
        { method: 'POST', headers: { 'x-omnis-csrf': csrfToken } },
        (value) => value,
      );
      setOwner(null);
      setTasks([]);
      setRuns([]);
      setSelectedRunId(null);
      setSelectedTaskId(null);
      setEvents([]);
      await refreshCsrf();
    } catch (cause) {
      if (!expireSessionIfNeeded(cause)) setError(failureMessage(cause, 'Sign out failed.'));
    }
  }

  if (checking)
    return (
      <main className="loading-screen" aria-live="polite">
        <span className="loading-mark">
          <Command size={22} />
        </span>
        <p>Opening Omnis OS…</p>
      </main>
    );
  if (!owner)
    return (
      <main className="auth-screen">
        <div className="auth-panel">
          <Brand />
          <div className="auth-copy">
            <h1>Welcome back.</h1>
            <p>Sign in to your local Omnis OS workspace.</p>
          </div>
          <form className="auth-form" onSubmit={signIn}>
            <label htmlFor="owner-password">Owner password</label>
            <input
              id="owner-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            {error && <ErrorNote message={error} />}
            {csrfBootstrapError && (
              <div className="error-note" role="alert">
                <X size={16} />
                <span>{csrfBootstrapError}</span>
                <button
                  type="button"
                  onClick={() => void refreshCsrf().catch(() => undefined)}
                  disabled={csrfLoading}
                >
                  {csrfLoading ? 'Preparing secure sign-in…' : 'Retry secure sign-in setup'}
                </button>
              </div>
            )}
            <button
              className="primary-button auth-submit"
              type="submit"
              disabled={busy || csrfLoading || !csrfToken}
            >
              <LockKeyhole size={16} /> {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
          <div className="local-note">
            <ShieldCheck size={15} />
            <span>Local owner session · provider credentials stay outside Omnis OS</span>
          </div>
        </div>
      </main>
    );

  const approvalDialog = approvalTask && (
    <ApprovalDialog
      task={approvalTask}
      busy={busy}
      error={approvalError}
      expiresAt={approvalExpiry}
      decisionUncertain={Boolean(approvalOperation?.decisionUncertain)}
      retryKind={
        approvalOperation?.decisionUncertain || approvalOperation?.canRetry === false
          ? 'close'
          : approvalOperation?.runUncertain
            ? 'run'
            : approvalOperation?.authorizationUncertain
              ? 'authorization'
              : 'start'
      }
      onCancel={closeApproval}
      onApprove={() => void startRun(approvalTask)}
    />
  );

  if (page === 'command-center')
    return (
      <>
        <Suspense
          fallback={
            <main
              className="loading-screen"
              role="status"
              style={{ background: '#060c0e', color: '#eaf4ee' }}
            >
              <p>Opening Command Center…</p>
            </main>
          }
        >
          <NexusCommandCenter
            ownerName={owner.displayName}
            navItems={navItems}
            tasks={tasks}
            runs={runs}
            tasksState={tasksLoading ? 'loading' : tasksError ? 'error' : 'ready'}
            runsState={runsLoading ? 'loading' : runsError ? 'error' : 'ready'}
            tasksError={tasksError}
            runsError={runsError}
            busy={busy}
            notice={
              error && (
                <div className="nx-notice" role="alert">
                  <X size={14} aria-hidden="true" />
                  <span>{error}</span>
                  <button
                    className="nx-btn"
                    aria-label="Dismiss error"
                    onClick={() => setError('')}
                  >
                    Dismiss
                  </button>
                </div>
              )
            }
            onSkip={skipToMain}
            onSignOut={() => void signOut()}
            onRetryTasks={() => void loadTasks()}
            onRetryRuns={() => void loadRuns()}
            onNavigate={(destination) => navigate(destination, setPage)}
            onOpenRun={(run) => {
              setSelectedRunId(run.id);
              navigate('runs', setPage, run.id);
            }}
            onStop={(run) => void stopRun(run)}
            onCreate={() => {
              navigate('tasks', setPage);
              window.setTimeout(() => document.getElementById('task-title')?.focus(), 0);
            }}
            onReviewApproval={openApproval}
          />
        </Suspense>
        {approvalDialog}
      </>
    );

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={skipToMain}>
        Skip to main content
      </a>
      <header className="topbar">
        <Brand />
        <nav className="primary-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={page === item.id ? 'page' : undefined}
              className={page === item.id ? 'nav-active' : ''}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <div className="topbar-actions">
          <div className="owner-chip">
            <span className="owner-avatar" aria-hidden="true">
              {owner.displayName.slice(0, 1)}
            </span>
            <span>{owner.displayName}</span>
          </div>
          <button
            className="icon-button"
            onClick={() => void signOut()}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <main id="main-content" className="main-content" tabIndex={-1}>
        <section className="page-heading">
          <div>
            <div className="heading-row">
              <h1>{pageTitles[page]}</h1>
              <span className="mock-badge">
                <Sparkles size={13} /> Mock-only mode
              </span>
            </div>
            <p>{pageSubtitles[page]}</p>
          </div>
          <div className="local-status">
            <span className="status-dot" /> Local workspace <span className="status-divider" />{' '}
            Asia/Manila time
          </div>
        </section>
        {error && <ErrorNote message={error} onDismiss={() => setError('')} />}
        {page === 'tasks' && (
          <TasksWorkspace
            tasks={tasks}
            runs={runs}
            loading={tasksLoading}
            error={tasksError}
            runsAvailable={!runsLoading && !runsError}
            onRetry={() => void loadTasks()}
            busy={busy}
            title={title}
            detail={detail}
            selectedTask={selectedTask}
            onTitle={setTitle}
            onDetail={setDetail}
            onCreate={createTask}
            onSelectTask={(task) => setSelectedTaskId(task.id)}
            onStart={(task, trigger) => openApproval(task, trigger)}
          />
        )}
        {page === 'runs' && (
          <RunsWorkspace
            runs={runs}
            tasks={tasks}
            selectedRun={selectedRun}
            events={events}
            loading={runsLoading}
            error={runsError}
            onRetry={() => void loadRuns()}
            streamState={streamState}
            busy={busy}
            reconcileError={reconcileError}
            onReconcile={() => selectedRunId && void reconcileRun(selectedRunId)}
            announcement={announcement}
            onSelectRun={(run) => {
              setSelectedRunId(run.id);
              navigate('runs', setPage, run.id);
            }}
            onClearRun={() => {
              setSelectedRunId(null);
              navigate('runs', setPage);
            }}
            onStop={(run) => void stopRun(run)}
          />
        )}
        {page === 'agents' && <AgentsWorkspace onUnauthorized={expireSessionIfNeeded} />}
        <footer className="page-foot">
          <ShieldCheck size={14} />
          <span>
            Mock activity is synthetic and never provider activity. No model was contacted.
          </span>
        </footer>
      </main>
      {approvalDialog}
    </div>
  );
}

const navItems = [
  { id: 'command-center' as const, label: 'Command Center', icon: Activity },
  { id: 'tasks' as const, label: 'Tasks', icon: ListChecks },
  { id: 'runs' as const, label: 'Runs', icon: FolderKanban },
  { id: 'agents' as const, label: 'Agents', icon: Users },
];
const pageTitles: Record<Page, string> = {
  'command-center': 'Command Center',
  tasks: 'Tasks',
  runs: 'Runs',
  agents: 'Agents & Profiles',
};
const pageSubtitles: Record<Page, string> = {
  'command-center': 'Your operational overview for tasks and synthetic runs.',
  tasks: 'Create and review work in your local workspace.',
  runs: 'Follow current and historical mock run activity.',
  agents: 'Review agent identities and immutable profile versions. Read-only in this release.',
};

// The app uses hash routing, so the default `#main-content` anchor jump would replace
// the current route. Move focus to the main landmark without touching location or history,
// then scroll to the start of main immediately (no animation), leaving room for the focus ring
// so its top edge is never above the viewport, even when main is taller than the viewport.
function skipToMain(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const main = document.getElementById('main-content');
  if (!main) return;
  main.focus({ preventScroll: true });
  const style = window.getComputedStyle(main);
  const ring =
    style.outlineStyle === 'none'
      ? 0
      : Number.parseFloat(style.outlineWidth) + Math.max(Number.parseFloat(style.outlineOffset), 0);
  const top = main.getBoundingClientRect().top + window.scrollY - ring - 6;
  window.scrollTo({ top: Math.max(top, 0), behavior: 'instant' });
}

function readRoute(): { page: Page; runId?: string } {
  const [head = '', encodedRunId] = window.location.hash.slice(1).split('/', 2);
  const destination = head.split('?', 1)[0];
  if (destination === 'agents') return { page: 'agents' };
  if (destination === 'tasks') return { page: 'tasks' };
  if (destination === 'runs') {
    if (!encodedRunId) return { page: 'runs' };
    try {
      return { page: 'runs', runId: decodeURIComponent(encodedRunId) };
    } catch {
      return { page: 'runs', runId: encodedRunId };
    }
  }
  return { page: 'command-center' };
}
function readRunId() {
  const route = readRoute();
  return route.page === 'runs' ? route.runId : undefined;
}
function navigate(destination: Page, setPage: (page: Page) => void, runId?: string) {
  setPage(destination);
  const hash =
    destination === 'runs' && runId ? `#runs/${encodeURIComponent(runId)}` : `#${destination}`;
  if (window.location.hash !== hash) window.location.hash = hash;
}

function Brand() {
  return (
    <a className="brand" href="#command-center" aria-label="Omnis OS home">
      <span className="brand-mark">
        <Command size={17} strokeWidth={2.2} />
      </span>
      <span>
        Omnis <b>OS</b>
      </span>
    </a>
  );
}
function ErrorNote({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  return (
    <div className="error-note" role="alert">
      <X size={16} />
      <span>{message}</span>
      {onDismiss && (
        <button aria-label="Dismiss error" onClick={onDismiss}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function ResourceLoading({ resource }: { resource: string }) {
  return (
    <div className="resource-loading" role="status">
      Loading {resource}…
    </div>
  );
}

function ResourceFailure({
  resource,
  message,
  onRetry,
}: {
  resource: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="resource-failure" role="alert">
      <div>
        <strong>{resource} unavailable</strong>
        <p>{message}</p>
      </div>
      <button className="secondary-button" onClick={onRetry}>
        Retry {resource.toLowerCase()}
      </button>
    </div>
  );
}

function TasksWorkspace({
  tasks,
  runs,
  loading,
  error,
  runsAvailable,
  onRetry,
  busy,
  title,
  detail,
  selectedTask,
  onTitle,
  onDetail,
  onCreate,
  onSelectTask,
  onStart,
}: {
  tasks: Task[];
  runs: Run[];
  loading: boolean;
  error: string;
  runsAvailable: boolean;
  onRetry: () => void;
  busy: boolean;
  title: string;
  detail: string;
  selectedTask: Task | null;
  onTitle: (value: string) => void;
  onDetail: (value: string) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onSelectTask: (task: Task) => void;
  onStart: (task: Task, trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="tasks-layout">
      <div className="tasks-primary">
        <section className="panel composer-panel">
          <div className="section-heading">
            <div>
              <h2>Create a task</h2>
              <p>Describe a clear, inspectable outcome.</p>
            </div>
            <span className="composer-icon">
              <FilePlus2 size={17} />
            </span>
          </div>
          <form className="task-composer" onSubmit={onCreate}>
            <label htmlFor="task-title">Task title</label>
            <input
              id="task-title"
              maxLength={120}
              minLength={3}
              placeholder="Give this task a clear outcome"
              value={title}
              onChange={(event) => onTitle(event.target.value)}
              required
            />
            <label htmlFor="task-detail">Task detail</label>
            <textarea
              id="task-detail"
              maxLength={2000}
              minLength={10}
              placeholder="Describe the read-only work you want to inspect…"
              value={detail}
              onChange={(event) => onDetail(event.target.value)}
              required
              rows={3}
            />
            <div className="composer-footer">
              <span>Mock runs are synthetic.</span>
              <button className="primary-button" type="submit" disabled={busy}>
                <Plus size={16} /> Create task
              </button>
            </div>
          </form>
        </section>
        <section className="panel list-panel">
          <div className="section-heading">
            <div>
              <h2>Task list</h2>
              <p>
                {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} in this workspace
              </p>
            </div>
          </div>
          {loading ? (
            <ResourceLoading resource="tasks" />
          ) : error ? (
            <ResourceFailure resource="Tasks" message={error} onRetry={onRetry} />
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={<FilePlus2 size={18} />}
              title="No tasks yet"
              detail="Your tasks will appear here after creation."
            />
          ) : (
            <ul className="task-list">
              {[...tasks]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((task) => {
                  const activeRun = runs.find(
                    (run) => run.taskId === task.id && isActive(run.status),
                  );
                  const disabledReason =
                    task.status === 'completed'
                      ? 'Completed tasks cannot be run again.'
                      : activeRun
                        ? 'An active run already exists for this task.'
                        : !runsAvailable
                          ? 'Load current runs before starting another run.'
                          : '';
                  return (
                    <li
                      key={task.id}
                      className={selectedTask?.id === task.id ? 'task-row selected' : 'task-row'}
                    >
                      <button
                        className="task-select"
                        onClick={() => onSelectTask(task)}
                        aria-pressed={selectedTask?.id === task.id}
                      >
                        <span className="task-mark">
                          <span className={`task-state state-${task.status}`} />
                        </span>
                        <span className="task-copy">
                          <strong>{task.title}</strong>
                          <span>{task.detail}</span>
                          <small>{formatDate(task.createdAt)}</small>
                        </span>
                      </button>
                      <StatusPill status={task.status} />
                      <button
                        className="run-task-button"
                        onClick={(event) => onStart(task, event.currentTarget)}
                        disabled={busy || Boolean(disabledReason)}
                        aria-describedby={disabledReason ? `task-run-reason-${task.id}` : undefined}
                        title={disabledReason || 'Review and approve a synthetic mock run'}
                      >
                        <Play size={15} />
                        <span>{activeRun ? 'In progress' : 'Approve & run'}</span>
                      </button>
                      {disabledReason && (
                        <span className="sr-only" id={`task-run-reason-${task.id}`}>
                          {disabledReason}
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
          )}
        </section>
      </div>
      <aside className="panel task-detail-panel">
        <div className="section-heading">
          <div>
            <h2>Task details</h2>
            <p>Selected task record</p>
          </div>
        </div>
        {selectedTask ? (
          <>
            <StatusPill status={selectedTask.status} />
            <h3>{selectedTask.title}</h3>
            <p className="detail-copy">{selectedTask.detail}</p>
            <dl className="metadata-list">
              <div>
                <dt>Created</dt>
                <dd>{formatDate(selectedTask.createdAt)}</dd>
              </div>
              <div>
                <dt>Task ID</dt>
                <dd>{selectedTask.id}</dd>
              </div>
              <div>
                <dt>Related runs</dt>
                <dd>{runs.filter((run) => run.taskId === selectedTask.id).length}</dd>
              </div>
            </dl>
          </>
        ) : (
          <EmptyState
            icon={<ListChecks size={18} />}
            title="Select a task"
            detail="Choose a task from the list to inspect its details."
          />
        )}
      </aside>
    </div>
  );
}

function RunsWorkspace({
  runs,
  tasks,
  selectedRun,
  events,
  loading,
  error,
  onRetry,
  streamState,
  busy,
  reconcileError,
  onReconcile,
  announcement,
  onSelectRun,
  onStop,
  onClearRun,
}: {
  runs: Run[];
  tasks: Task[];
  selectedRun: Run | null;
  events: RunEvent[];
  loading: boolean;
  error: string;
  onRetry: () => void;
  streamState: StreamState;
  busy: boolean;
  reconcileError: string;
  onReconcile: () => void;
  announcement: string;
  onSelectRun: (run: Run) => void;
  onStop: (run: Run) => void;
  onClearRun: () => void;
}) {
  const orderedRuns = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div className="runs-layout">
      <section className="panel run-history">
        <div className="section-heading">
          <div>
            <h2>Run history</h2>
            <p>
              {runs.length} persisted {runs.length === 1 ? 'run' : 'runs'}
            </p>
          </div>
        </div>
        {loading ? (
          <ResourceLoading resource="runs" />
        ) : error ? (
          <ResourceFailure resource="Runs" message={error} onRetry={onRetry} />
        ) : runs.length ? (
          <ul className="history-list">
            {orderedRuns.map((run) => (
              <li key={run.id}>
                <button
                  className={selectedRun?.id === run.id ? 'history-row selected' : 'history-row'}
                  aria-pressed={selectedRun?.id === run.id}
                  onClick={() => onSelectRun(run)}
                >
                  <span className="history-icon">
                    <Activity size={16} />
                  </span>
                  <span className="history-copy">
                    <strong>{run.taskTitle}</strong>
                    <small>{formatDate(run.createdAt)}</small>
                  </span>
                  <StatusPill status={run.status} />
                  <ArrowRight size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<Activity size={18} />}
            title="No runs recorded"
            detail="Approved mock runs will appear here."
          />
        )}
      </section>
      <RunInspector
        run={selectedRun}
        loading={loading}
        error={error}
        unknownRunId={!loading && !error && !selectedRun && readRunId() ? readRunId() : undefined}
        onRetry={onRetry}
        onClearRun={onClearRun}
        tasks={tasks}
        events={events}
        streamState={streamState}
        busy={busy}
        onStop={onStop}
        reconcileError={reconcileError}
        onReconcile={onReconcile}
        announcement={announcement}
      />
    </div>
  );
}

function RunInspector({
  run,
  loading,
  error,
  unknownRunId,
  onRetry,
  onClearRun,
  tasks,
  events,
  streamState,
  busy,
  onStop,
  reconcileError,
  onReconcile,
  announcement,
}: {
  run: Run | null;
  loading: boolean;
  error: string;
  unknownRunId: string | undefined;
  onRetry: () => void;
  onClearRun: () => void;
  tasks: Task[];
  events: RunEvent[];
  streamState: StreamState;
  busy: boolean;
  onStop: (run: Run) => void;
  reconcileError: string;
  onReconcile: () => void;
  announcement: string;
}) {
  const task = run ? tasks.find((item) => item.id === run.taskId) : null;
  return (
    <aside className="panel run-inspector" aria-label="Run inspector">
      <div className="section-heading">
        <div>
          <h2 id="run-inspector-heading" tabIndex={-1}>
            Run inspector
          </h2>
          <p>State and ordered event trail</p>
        </div>
        {run && (
          <span className={`stream-badge stream-${streamState}`}>
            <span />
            {streamLabel(streamState)}
          </span>
        )}
      </div>
      {!run ? (
        loading ? (
          <ResourceLoading resource="run details" />
        ) : error ? (
          <ResourceFailure resource="Runs" message={error} onRetry={onRetry} />
        ) : unknownRunId ? (
          <EmptyState
            icon={<Activity size={18} />}
            title="Run not found"
            detail={`No run with ID ${unknownRunId} is available in the current run history.`}
            action={
              <button className="text-button" onClick={onClearRun}>
                Return to run history
              </button>
            }
          />
        ) : (
          <EmptyState
            icon={<Activity size={18} />}
            title="Select a run"
            detail="Choose a run from history to inspect its state and events."
          />
        )
      ) : (
        <>
          <div className="inspector-summary">
            <StatusPill status={run.status} />
            <span className="runtime-kind">SYNTHETIC MOCK</span>
            <h3>{run.taskTitle}</h3>
            <div className="metadata-list">
              <div>
                <span>Task</span>
                <strong>{task?.title ?? run.taskId}</strong>
              </div>
              <div>
                <span>Run ID</span>
                <strong>{run.id}</strong>
              </div>
              <div>
                <span>Created</span>
                <strong>{formatDate(run.createdAt)}</strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>{formatDate(run.updatedAt)}</strong>
              </div>
            </div>
            {isActive(run.status) && (
              <button
                className="stop-button"
                onClick={() => onStop(run)}
                disabled={busy || run.status === 'stopping'}
              >
                <CircleStop size={15} />
                {run.status === 'stopping' ? 'Stop requested' : 'Request stop'}
              </button>
            )}
          </div>
          <div className="event-heading">
            <h3>Event trail</h3>
            <span>
              {events.length} {events.length === 1 ? 'event' : 'events'}
            </span>
          </div>
          {reconcileError && (
            <div className="error-note reconcile-error" role="alert">
              <X size={16} />
              <span>{reconcileError}</span>
              <button onClick={onReconcile}>Retry state check</button>
            </div>
          )}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {announcement}
          </span>
          {events.length ? (
            <div
              className="event-scroll"
              tabIndex={0}
              role="region"
              aria-label={`Event history for ${run.taskTitle}`}
            >
              <ol className="event-list">
                {events.map((event) => (
                  <EventRow key={event.id} event={event} />
                ))}
              </ol>
            </div>
          ) : (
            <div className="event-empty" role="status">
              <Clock3 size={15} />
              {streamState === 'connecting'
                ? 'Connecting to the run event stream…'
                : streamState === 'reconnecting'
                  ? 'Event stream disconnected. Reconnecting…'
                  : streamState === 'closed'
                    ? 'Event stream closed. Refresh the page to reconnect.'
                    : 'Waiting for run events…'}
            </div>
          )}
          {run.status === 'completed' && (
            <div className="unverified-note">
              <Check size={15} />
              <p>This run completed. Its output remains synthetic and is not a verified result.</p>
            </div>
          )}
          {run.status === 'failed' && (
            <div className="run-notice">
              <X size={15} />
              <p>This run failed. Review the event trail for its recorded state changes.</p>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function StatusPill({ status }: { status: Run['status'] | Task['status'] }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span />
      {statusLabel(status)}
    </span>
  );
}
function EmptyState({
  icon,
  title,
  detail,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <strong>{title}</strong>
      <p>{detail}</p>
      {action}
    </div>
  );
}
function streamLabel(state: StreamState) {
  return {
    connecting: 'Connecting',
    connected: 'Live stream',
    reconnecting: 'Reconnecting',
    closed: 'Disconnected',
    ended: 'Stream ended',
  }[state];
}

function EventRow({ event }: { event: RunEvent }) {
  return (
    <li className={`event-row event-${event.type.split('.')[1]}`}>
      <span className="event-marker">
        {event.type === 'run.completed' ? <Check size={12} /> : <span />}
      </span>
      <div className="event-body">
        <div className="event-title">
          <strong>{event.type.replace('run.', '').replaceAll('_', ' ')}</strong>
          <time dateTime={event.at}>
            {formatDate(event.at, { dateStyle: undefined, timeStyle: 'medium' })}
          </time>
        </div>
        <p>{event.message}</p>
        <span className="event-source">Event {event.sequence} · mock source · synthetic</span>
      </div>
    </li>
  );
}

function ApprovalDialog({
  task,
  busy,
  error,
  expiresAt,
  decisionUncertain,
  retryKind,
  onCancel,
  onApprove,
}: {
  task: Task;
  busy: boolean;
  error: string;
  expiresAt: string;
  decisionUncertain: boolean;
  retryKind: 'start' | 'authorization' | 'run' | 'close';
  onCancel: () => void;
  onApprove: () => void;
}) {
  useEffect(() => {
    const dialog = document.getElementById('approval-dialog') as HTMLDialogElement | null;
    if (dialog && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      id="approval-dialog"
      className="approval-dialog"
      aria-labelledby="approval-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <div className="dialog-icon">
          <ShieldCheck size={20} />
        </div>
        <span className="eyebrow">OWNER APPROVAL</span>
        <h2 id="approval-title">Approve one synthetic run?</h2>
        <p>
          This approval is limited to the task below and the mock execution capability. Omnis OS
          sets the expiry and permits one mock run.
        </p>
        {expiresAt && (
          <p className="approval-expiry">
            Approval expires <time dateTime={expiresAt}>{formatDate(expiresAt)}</time>.
          </p>
        )}
        <div className="approval-task">
          <strong>{task.title}</strong>
          <span>{task.detail}</span>
        </div>
        {error && (
          <div className="error-note dialog-error" role="alert">
            <X size={16} />
            <span>{error}</span>
          </div>
        )}
        <div className="dialog-foot">
          <button type="button" className="secondary-button" onClick={onCancel} disabled={busy}>
            {decisionUncertain ? 'Close' : 'Cancel'}
          </button>
          {retryKind !== 'close' && (
            <button type="button" className="primary-button" onClick={onApprove} disabled={busy}>
              <ShieldCheck size={15} />
              {busy
                ? 'Working…'
                : retryKind === 'authorization'
                  ? 'Retry approval request'
                  : retryKind === 'run'
                    ? 'Retry run request'
                    : 'Approve & run'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}

export { App };
