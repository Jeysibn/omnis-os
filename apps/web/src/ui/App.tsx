import {
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
  Briefcase,
  Check,
  CircleStop,
  Clock3,
  Command,
  FilePlus2,
  FolderKanban,
  ListChecks,
  LockKeyhole,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import {
  AuthorizationSchema,
  CreateTaskSchema,
  ProjectIdSchema,
  RunEventSchema,
  RunSchema,
  TaskSchema,
  type ProjectSummary,
  type Authorization,
  type Run,
  type RunEvent,
  type Task,
} from '@omnis/contracts';
import { ApiRequestError, request } from './api.js';
import { formatDate } from './manilaTime.js';
import { AcceptResultAction } from './AcceptResultAction.js';
import { isAwaitingOwnerReview } from './acceptResult.js';
import { CommandCenter } from './command-center/CommandCenter.js';
import {
  createRunStreamBudget,
  createRunStreamRecovery,
  resetRunStreamBudget,
  type RunStreamBudget,
  type SessionProbeResult,
} from './runStreamRecovery.js';
import { AgentsWorkspace } from './agents/AgentsWorkspace.js';
import { DepartmentsWorkspace } from './departments/DepartmentsWorkspace.js';
import { ProjectsWorkspace } from './projects/ProjectsWorkspace.js';
import { parseProjectList } from './projects/data.js';
import { AppHeader } from './shell/AppHeader.js';
import { SyntheticAuditHistory } from './SyntheticAuditHistory.js';
import { TaskExecutionAssignmentEditor } from './TaskExecutionAssignmentEditor.js';
import { SyntheticConnectorRunAction } from './SyntheticConnectorRunAction.js';

type Owner = { id: string; displayName: string };
type Page = 'command-center' | 'tasks' | 'runs' | 'agents' | 'departments' | 'projects';
type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'ended' | 'paused';
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
type TaskCreateOperation = {
  title: string;
  detail: string;
  projectId: string | null;
  idempotencyKey: string | null;
};
const pendingTaskCreateStorageKey = 'omnis.pending-task-create.v1';
const idempotencyKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredTaskCreate = { ownerId: string; operation: TaskCreateOperation };

function readPendingTaskCreate(): StoredTaskCreate | null {
  try {
    const stored = sessionStorage.getItem(pendingTaskCreateStorageKey);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('ownerId' in value) ||
      typeof value.ownerId !== 'string' ||
      !value.ownerId ||
      !('operation' in value) ||
      typeof value.operation !== 'object' ||
      value.operation === null ||
      !('idempotencyKey' in value.operation)
    ) {
      sessionStorage.removeItem(pendingTaskCreateStorageKey);
      return null;
    }
    const operation = CreateTaskSchema.safeParse(value.operation);
    const idempotencyKey = value.operation.idempotencyKey;
    if (
      !operation.success ||
      operation.data.projectId == null ||
      typeof idempotencyKey !== 'string' ||
      !idempotencyKeyPattern.test(idempotencyKey)
    ) {
      sessionStorage.removeItem(pendingTaskCreateStorageKey);
      return null;
    }
    return {
      ownerId: value.ownerId,
      operation: {
        ...operation.data,
        projectId: operation.data.projectId,
        idempotencyKey,
      },
    };
  } catch {
    return null;
  }
}

function storePendingTaskCreate(
  ownerId: string | null,
  operation: TaskCreateOperation | null,
): boolean {
  try {
    if (operation && ownerId)
      sessionStorage.setItem(pendingTaskCreateStorageKey, JSON.stringify({ ownerId, operation }));
    else if (operation) return false;
    else sessionStorage.removeItem(pendingTaskCreateStorageKey);
    return true;
  } catch {
    return false;
  }
}

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
    case 'run.outcome_unknown':
      return 'unknown';
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
  // A finished run is not an accepted task: in_review reads as pending owner review.
  if (status === 'in_review') return 'Awaiting review';
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function App() {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [checking, setChecking] = useState(true);
  const [csrfToken, setCsrfToken] = useState('');
  const [csrfLoading, setCsrfLoading] = useState(false);
  const [csrfBootstrapError, setCsrfBootstrapError] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [tasksLoading, setTasksLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(true);
  const [tasksError, setTasksError] = useState('');
  const [runsError, setRunsError] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => readRoute().taskId ?? null,
  );
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [streamEpoch, setStreamEpoch] = useState(0);
  const recreatingStream = useRef(false);
  // Identifies the current owner session. Anything started under an older value (a delayed
  // session probe, a retry budget) must not affect the session that replaced it.
  const sessionGeneration = useRef(0);
  const streamBudgets = useRef(new Map<string, RunStreamBudget>());
  // Freshness gate after an acceptance 409. Owned here so selection changes cannot clear it; it
  // is conservative (covers every task and run) until both authoritative reads are applied.
  const [acceptGate, setAcceptGate] = useState<{
    phase: 'idle' | 'refreshing' | 'failed' | 'done';
    runId: string | null;
  }>({ phase: 'idle', runId: null });
  const gateSeq = useRef(0);
  const rotateSession = useCallback(() => {
    sessionGeneration.current += 1;
    // A new session reads fresh data on sign-in; an old refresh must not touch it.
    gateSeq.current += 1;
    setAcceptGate({ phase: 'idle', runId: null });
    streamBudgets.current.clear();
  }, []);
  const [page, setPage] = useState<Page>(() => readRoute().page);
  const [restoredTaskCreate] = useState(readPendingTaskCreate);
  const [title, setTitle] = useState(() => restoredTaskCreate?.operation.title ?? '');
  const [detail, setDetail] = useState(() => restoredTaskCreate?.operation.detail ?? '');
  const [taskProjectId, setTaskProjectId] = useState(
    () => restoredTaskCreate?.operation.projectId ?? '',
  );
  const [invalidTaskProjectSelection, setInvalidTaskProjectSelection] = useState(false);
  const [pendingTaskCreate, setPendingTaskCreate] = useState<TaskCreateOperation | null>(
    () => restoredTaskCreate?.operation ?? null,
  );
  const [pendingTaskCreateOwnerId, setPendingTaskCreateOwnerId] = useState<string | null>(
    () => restoredTaskCreate?.ownerId ?? null,
  );
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
  const ownerRef = useRef(owner);
  const pendingTaskCreateRef = useRef(pendingTaskCreate);
  const pendingTaskCreateOwnerIdRef = useRef(pendingTaskCreateOwnerId);
  ownerRef.current = owner;
  pendingTaskCreateRef.current = pendingTaskCreate;
  pendingTaskCreateOwnerIdRef.current = pendingTaskCreateOwnerId;
  // False until the first in-app hash navigation, so a direct load of a screen never steals focus.
  const navigatedInApp = useRef(false);
  const stopInFlight = useRef(new Set<string>());
  const taskCreateInFlight = useRef(false);
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
      rotateSession();
      setOwner(null);
      setCsrfToken('');
      setTasks([]);
      setRuns([]);
      setProjects([]);
      setProjectsLoaded(false);
      setProjectsError('');
      setSelectedRunId(null);
      setSelectedTaskId(null);
      setEvents([]);
      setApprovalTask(null);
      setApprovalOperation(null);
      const keepPendingTaskCreate =
        pendingTaskCreateRef.current !== null &&
        pendingTaskCreateOwnerIdRef.current !== null &&
        ownerRef.current?.id === pendingTaskCreateOwnerIdRef.current;
      if (!keepPendingTaskCreate) {
        setPendingTaskCreate(null);
        setPendingTaskCreateOwnerId(null);
        storePendingTaskCreate(null, null);
      }
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
    [refreshCsrf, rotateSession],
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

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError('');
    try {
      const result = await request('/api/v1/projects', {}, parseProjectList);
      setProjects(result.projects.filter((project) => project.status === 'active'));
      setProjectsLoaded(true);
    } catch (cause) {
      if (!expireSessionIfNeeded(cause))
        setProjectsError(failureMessage(cause, 'Projects could not be loaded.'));
    } finally {
      setProjectsLoading(false);
    }
  }, [expireSessionIfNeeded]);

  useEffect(() => {
    if (
      !owner ||
      !pendingTaskCreate ||
      !pendingTaskCreateOwnerId ||
      projectsLoaded ||
      projectsLoading ||
      projectsError
    )
      return;
    void loadProjects();
  }, [
    loadProjects,
    owner,
    pendingTaskCreate,
    pendingTaskCreateOwnerId,
    projectsError,
    projectsLoaded,
    projectsLoading,
  ]);

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

  /** Re-read tasks without the list's loading state; a failed read keeps what is shown. */
  const refreshTasksQuietly = useCallback(async () => {
    try {
      const taskData = await request('/api/v1/tasks', {}, parseTaskList);
      setTasks(taskData);
    } catch (cause) {
      expireSessionIfNeeded(cause);
    }
  }, [expireSessionIfNeeded]);

  /**
   * Authoritative re-read after a 409 (or an explicit reload). Both reads must succeed, and this
   * must still be the newest refresh of the same session, before anything is applied or the gate
   * moves. A superseded refresh or an older session's answer changes nothing.
   */
  const refreshAfterConflict = useCallback(
    async (runId: string) => {
      const generation = sessionGeneration.current;
      const seq = (gateSeq.current += 1);
      const live = () => generation === sessionGeneration.current && seq === gateSeq.current;
      setAcceptGate({ phase: 'refreshing', runId });
      try {
        const [taskData, runData] = await Promise.all([
          request('/api/v1/tasks', {}, parseTaskList),
          request('/api/v1/runs', {}, parseRunList),
        ]);
        if (!live()) return;
        setTasks(taskData);
        setRuns(runData);
        setAcceptGate({ phase: 'done', runId });
      } catch (cause) {
        if (generation !== sessionGeneration.current) return;
        if (expireSessionIfNeeded(cause)) return;
        if (live()) setAcceptGate({ phase: 'failed', runId });
      }
    },
    [expireSessionIfNeeded],
  );

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
        // A finished run moves its task on the server (a completed mock run leaves the task in
        // review). The run stream is run-scoped and never carries that, so read the task again.
        if (run.status === 'completed') await refreshTasksQuietly();
      } catch (cause) {
        if (!expireSessionIfNeeded(cause)) {
          setReconcileError(failureMessage(cause, 'The final run state could not be confirmed.'));
        }
      }
    },
    [expireSessionIfNeeded, refreshTasksQuietly],
  );

  // Authenticated Run read used to tell a dropped network from an ended owner session after a
  // stream error. 401 goes through the existing sign-out flow; 403 and other refusals are shown
  // without signing out; network and server trouble never sign the owner out.
  const probeRunSession = useCallback(
    async (runId: string, signal: AbortSignal): Promise<SessionProbeResult> => {
      // The session this probe was made for. Every outcome below is checked against it BEFORE any
      // side effect, so a late answer for an old session (for example a 401 for a cookie that was
      // replaced by a new sign-in) can never sign out or alter the session that replaced it.
      const generation = sessionGeneration.current;
      const stale = () => signal.aborted || generation !== sessionGeneration.current;
      try {
        const run = await request(
          `/api/v1/runs/${encodeURIComponent(runId)}`,
          { signal },
          (value) => RunSchema.parse(value),
        );
        if (stale()) return 'stale';
        setRuns((current) => current.map((entry) => (entry.id === run.id ? run : entry)));
        return 'valid';
      } catch (cause) {
        if (stale()) return 'stale';
        if (expireSessionIfNeeded(cause)) return 'unauthorized';
        if (cause instanceof ApiRequestError && cause.outcome === 'uncertain') return 'unreachable';
        setReconcileError(failureMessage(cause, 'Access to this run could not be confirmed.'));
        return 'rejected';
      }
    },
    [expireSessionIfNeeded],
  );

  useEffect(() => {
    const onHashChange = () => {
      navigatedInApp.current = true;
      const route = readRoute();
      setPage(route.page);
      if (route.page === 'runs') setSelectedRunId(route.runId ?? null);
      if (route.page === 'tasks' && route.taskId) setSelectedTaskId(route.taskId);
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
        if (restoredTaskCreate && restoredTaskCreate.ownerId !== currentOwner.id) {
          setPendingTaskCreate(null);
          setPendingTaskCreateOwnerId(null);
          setTitle('');
          setDetail('');
          setTaskProjectId('');
          storePendingTaskCreate(null, null);
        }
        rotateSession();
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
  }, [loadWorkspace, refreshCsrf, restoredTaskCreate, rotateSession]);

  useEffect(() => {
    if (!owner || page !== 'runs' || !selectedRunId || !selectedRunExists) {
      setEvents([]);
      setStreamState('closed');
      return;
    }
    // The retry budget belongs to the session and Run, not to this effect instance, so a stream
    // recreated here (or an unrelated effect re-run) cannot obtain a fresh allowance.
    let budget = streamBudgets.current.get(selectedRunId);
    if (!budget) {
      budget = createRunStreamBudget();
      streamBudgets.current.set(selectedRunId, budget);
    }
    if (budget.exhausted) {
      // Stay stopped until the owner explicitly retries; keep whatever history is on screen.
      recreatingStream.current = false;
      setStreamState('paused');
      return;
    }
    // A recreated stream (after a confirmed-valid session) keeps what is on screen: the new
    // connection replays from the start and the sequence set below drops the duplicates.
    const recreated = recreatingStream.current;
    recreatingStream.current = false;
    if (!recreated) {
      setEvents([]);
      setReconcileError('');
      setAnnouncement('');
      seenSequences.current.set(selectedRunId, new Set());
    }
    setStreamState('connecting');
    let terminalHandled = false;
    const recovery = createRunStreamRecovery({
      budget,
      probe: (signal) => probeRunSession(selectedRunId, signal),
      recreate: () => {
        recreatingStream.current = true;
        setStreamEpoch((epoch) => epoch + 1);
      },
      onExhausted: () => {
        // Closing is what stops the browser's own reconnect loop; stopping our probes would not.
        source.close();
        setStreamState('paused');
        setAnnouncement(
          'Live updates paused after repeated connection problems. Use Retry live updates to try again.',
        );
      },
    });
    const source = new EventSource(`/api/v1/runs/${encodeURIComponent(selectedRunId)}/events`);
    const eventNames = [
      'run.queued',
      'run.started',
      'run.provider_submission_requested',
      'run.output',
      'run.stop_requested',
      'run.completed',
      'run.cancelled',
      'run.failed',
      'run.interrupted',
      'run.outcome_unknown',
    ];
    source.onopen = () => {
      recovery.opened();
      setStreamState('connected');
    };
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
          recovery.progress(); // an event not seen before is the only per-event progress
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
              'run.outcome_unknown',
            ].includes(parsed.type)
          ) {
            setAnnouncement(
              `${parsed.type.replace('run.', '').replaceAll('_', ' ')}: ${parsed.message}`,
            );
          }
          if (parsed.type === 'run.outcome_unknown') void reconcileRun(selectedRunId);
          if (
            parsed.sequence > newestSequence &&
            parsed.type !== 'run.outcome_unknown' &&
            terminalStatus(parsed.type) &&
            !terminalHandled
          ) {
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
      if (terminalHandled) return;
      const closed = source.readyState === EventSource.CLOSED;
      setStreamState(closed ? 'closed' : 'reconnecting');
      // EventSource hides the HTTP status; ask the authenticated API whether the session is valid.
      recovery.streamError(closed);
    };
    return () => {
      recovery.dispose();
      handlers.forEach(([name, handler]) => source.removeEventListener(name, handler));
      source.close();
    };
  }, [owner, page, probeRunSession, reconcileRun, selectedRunExists, selectedRunId, streamEpoch]);

  function retryStream() {
    if (!selectedRunId) return;
    const budget = streamBudgets.current.get(selectedRunId);
    if (budget) resetRunStreamBudget(budget);
    recreatingStream.current = true; // keep the history on screen; replays are de-duplicated
    setStreamEpoch((epoch) => epoch + 1);
    // The Retry button is replaced as soon as the stream reconnects; keep keyboard focus nearby.
    document.getElementById('run-inspector-heading')?.focus();
  }

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
      rotateSession(); // the session cookie just changed: older in-flight work is now stale
      setPassword('');
      const token = await refreshCsrf();
      const currentOwner = await request('/api/v1/me', {}, parseOwner);
      if (
        (restoredTaskCreate && restoredTaskCreate.ownerId !== currentOwner.id) ||
        (pendingTaskCreateOwnerId !== null && pendingTaskCreateOwnerId !== currentOwner.id)
      ) {
        setPendingTaskCreate(null);
        setPendingTaskCreateOwnerId(null);
        setTitle('');
        setDetail('');
        setTaskProjectId('');
        storePendingTaskCreate(null, null);
      }
      setOwner(currentOwner);
      setCsrfToken(token);
      await loadWorkspace();
    } catch (cause) {
      setError(failureMessage(cause, 'Sign in could not be completed.'));
    } finally {
      setBusy(false);
    }
  }

  async function submitTaskCreate(operation: TaskCreateOperation) {
    if (taskCreateInFlight.current) return;
    taskCreateInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const task = await request(
        '/api/v1/tasks',
        {
          method: 'POST',
          headers: {
            'x-omnis-csrf': csrfToken,
            ...(operation.idempotencyKey ? { 'idempotency-key': operation.idempotencyKey } : {}),
          },
          body: JSON.stringify({
            title: operation.title,
            detail: operation.detail,
            ...(operation.projectId ? { projectId: operation.projectId } : {}),
          }),
        },
        (value) => {
          const created = TaskSchema.parse(value);
          if (
            created.title !== operation.title.trim() ||
            created.detail !== operation.detail.trim() ||
            (created.projectId ?? null) !== operation.projectId
          ) {
            throw new Error('Created task does not match the request.');
          }
          return created;
        },
      );
      setTasks((current) => [task, ...current]);
      setSelectedTaskId(task.id);
      setTitle('');
      setDetail('');
      setTaskProjectId('');
      setPendingTaskCreate(null);
      setPendingTaskCreateOwnerId(null);
      storePendingTaskCreate(null, null);
    } catch (cause) {
      const sessionExpired = expireSessionIfNeeded(cause);
      if (sessionExpired) {
        // Keep a same-owner uncertain operation for explicit retry after sign-in.
      } else if (
        operation.projectId &&
        !(cause instanceof ApiRequestError && cause.outcome === 'rejected')
      ) {
        setPendingTaskCreate(operation);
        setPendingTaskCreateOwnerId(owner?.id ?? null);
        const saved = storePendingTaskCreate(owner?.id ?? null, operation);
        setError(
          saved
            ? 'The project task request may have been accepted, but its result was not confirmed. The form is locked; retry the exact request with the same idempotency key.'
            : 'The project task request may have been accepted, but its result was not confirmed. The form is locked; retry the exact request with the same idempotency key. Recovery could not be saved for a page refresh.',
        );
      } else {
        if (pendingTaskCreate) {
          setPendingTaskCreate(null);
          setPendingTaskCreateOwnerId(null);
          storePendingTaskCreate(null, null);
        }
        setError(
          cause instanceof ApiRequestError && cause.outcome !== 'rejected'
            ? 'Task creation could not be confirmed. Reload Tasks and check for the task before trying again.'
            : failureMessage(cause, 'Task could not be created.'),
        );
      }
    } finally {
      taskCreateInFlight.current = false;
      setBusy(false);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingTaskCreate) {
      await submitTaskCreate(pendingTaskCreate);
      return;
    }
    if (invalidTaskProjectSelection) {
      setError('Choose a valid active project or create this task without a project.');
      return;
    }
    const projectId = taskProjectId ? ProjectIdSchema.safeParse(taskProjectId) : null;
    if (projectId && !projectId.success) {
      setError('Choose a valid active project or create this task without a project.');
      return;
    }
    const parsed = CreateTaskSchema.safeParse({
      title,
      detail,
      ...(projectId?.success ? { projectId: projectId.data } : {}),
    });
    if (!parsed.success) {
      setError('Enter a valid task title and detail before creating the task.');
      return;
    }
    const operation: TaskCreateOperation = {
      title: parsed.data.title,
      detail: parsed.data.detail,
      projectId: parsed.data.projectId ?? null,
      idempotencyKey: parsed.data.projectId ? crypto.randomUUID() : null,
    };
    await submitTaskCreate(operation);
  }

  async function retryTaskCreate() {
    if (pendingTaskCreate) await submitTaskCreate(pendingTaskCreate);
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
      rotateSession();
      setOwner(null);
      setTasks([]);
      setRuns([]);
      setPendingTaskCreate(null);
      setPendingTaskCreateOwnerId(null);
      storePendingTaskCreate(null, null);
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

  return (
    <div className="app-shell" data-view={page}>
      <a className="skip-link" href="#main-content" onClick={skipToMain}>
        Skip to main content
      </a>
      <AppHeader
        brand={<Brand />}
        items={navItems}
        activeId={page}
        ownerName={owner.displayName}
        onSignOut={() => void signOut()}
      />
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
        {page === 'command-center' && (
          <CommandCenter
            tasks={tasks}
            runs={runs}
            tasksLoading={tasksLoading}
            runsLoading={runsLoading}
            tasksError={tasksError}
            runsError={runsError}
            busy={busy}
            onRetryTasks={() => void loadTasks()}
            onRetryRuns={() => void loadRuns()}
            onNavigate={(destination) => navigate(destination, setPage)}
            onSelectRun={(run) => {
              setSelectedRunId(run.id);
              navigate('runs', setPage, run.id);
            }}
            onStop={(run) => void stopRun(run)}
            onCreate={() => {
              navigate('tasks', setPage);
              window.setTimeout(() => document.getElementById('task-title')?.focus(), 0);
            }}
            onReviewApproval={(task, trigger) => openApproval(task, trigger)}
          />
        )}
        {page === 'tasks' && (
          <TasksWorkspace
            tasks={tasks}
            runs={runs}
            projects={projects}
            projectsLoading={projectsLoading}
            projectsLoaded={projectsLoaded}
            projectsError={projectsError}
            onRetryProjects={() => void loadProjects()}
            loading={tasksLoading}
            error={tasksError}
            runsAvailable={!runsLoading && !runsError}
            onRetry={() => void loadTasks()}
            busy={busy}
            title={title}
            detail={detail}
            projectId={taskProjectId}
            pendingTaskCreate={pendingTaskCreate}
            selectedTask={selectedTask}
            ownerId={owner?.id ?? ''}
            csrfToken={csrfToken}
            onSessionExpired={expireSessionIfNeeded}
            onTaskUpdated={(updated) => {
              setTasks((current) =>
                current.map((task) => (task.id === updated.id ? updated : task)),
              );
            }}
            onRunAdmitted={(run) => {
              setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
              setSelectedRunId(run.id);
              navigate('runs', setPage, run.id);
            }}
            onTitle={setTitle}
            onDetail={setDetail}
            onProjectId={(value) => {
              const parsed = ProjectIdSchema.safeParse(value);
              if (value === '' || parsed.success) {
                setTaskProjectId(value);
                setInvalidTaskProjectSelection(false);
              } else
                setError('Choose a valid active project or create this task without a project.');
            }}
            onInvalidProjectId={() => {
              setInvalidTaskProjectSelection(true);
              setError('Choose a valid active project or create this task without a project.');
            }}
            onCreate={createTask}
            onRetryCreate={retryTaskCreate}
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
            onRetryStream={retryStream}
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
            acceptance={{
              ownerId: owner.id,
              csrfToken,
              onAccepted: (updated) =>
                setTasks((current) =>
                  current.map((task) => (task.id === updated.id ? updated : task)),
                ),
              onSessionExpired: expireSessionIfNeeded,
              gate: acceptGate,
              onConflict: (runId) => void refreshAfterConflict(runId),
              onReload: (runId) => void refreshAfterConflict(runId),
              getSessionGeneration: () => sessionGeneration.current,
            }}
          />
        )}
        {page === 'agents' && (
          <AgentsWorkspace onUnauthorized={expireSessionIfNeeded} csrfToken={csrfToken} />
        )}
        {page === 'departments' && (
          <DepartmentsWorkspace
            onUnauthorized={expireSessionIfNeeded}
            csrfToken={csrfToken}
            refreshCsrf={refreshCsrf}
            arrivedByNavigation={navigatedInApp.current}
          />
        )}
        {page === 'projects' && (
          <ProjectsWorkspace
            ownerId={owner.id}
            onUnauthorized={expireSessionIfNeeded}
            csrfToken={csrfToken}
            refreshCsrf={refreshCsrf}
            arrivedByNavigation={navigatedInApp.current}
          />
        )}
        <footer className="page-foot">
          <ShieldCheck size={14} />
          <span>
            Mock activity is synthetic and never provider activity. No model was contacted.
          </span>
        </footer>
      </main>
      {approvalTask && (
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
      )}
    </div>
  );
}

const navItems = [
  { id: 'command-center' as const, label: 'Command Center', icon: Activity },
  { id: 'tasks' as const, label: 'Tasks', icon: ListChecks },
  { id: 'runs' as const, label: 'Runs', icon: FolderKanban },
  { id: 'agents' as const, label: 'Agents', icon: Users },
  { id: 'projects' as const, label: 'Projects', icon: Briefcase },
];
const pageTitles: Record<Page, string> = {
  'command-center': 'Command Center',
  tasks: 'Tasks',
  runs: 'Runs',
  agents: 'Agents & Profiles',
  departments: 'Departments',
  projects: 'Projects',
};
const pageSubtitles: Record<Page, string> = {
  'command-center': 'Your operational overview for tasks and synthetic runs.',
  tasks: 'Create and review work in your local workspace.',
  runs: 'Follow current and historical mock run activity.',
  agents: 'Manage agent identities and immutable profile versions.',
  departments: 'Create and rename the departments agents belong to.',
  projects: 'Create, edit and archive projects, and follow the tasks and runs inside each one.',
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

function readRoute(): { page: Page; runId?: string; taskId?: string } {
  const [head = '', encodedRunId] = window.location.hash.slice(1).split('/', 2);
  const destination = head.split('?', 1)[0];
  if (destination === 'agents') return { page: 'agents' };
  if (destination === 'departments') return { page: 'departments' };
  if (destination === 'projects') return { page: 'projects' };
  if (destination === 'tasks') {
    // `#tasks/<id>` opens the Tasks screen with that task selected.
    if (!encodedRunId) return { page: 'tasks' };
    try {
      return { page: 'tasks', taskId: decodeURIComponent(encodedRunId) };
    } catch {
      return { page: 'tasks' };
    }
  }
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
  projects,
  projectsLoading,
  projectsLoaded,
  projectsError,
  onRetryProjects,
  loading,
  error,
  runsAvailable,
  onRetry,
  busy,
  title,
  detail,
  projectId,
  pendingTaskCreate,
  selectedTask,
  ownerId,
  csrfToken,
  onSessionExpired,
  onTaskUpdated,
  onRunAdmitted,
  onTitle,
  onDetail,
  onProjectId,
  onInvalidProjectId,
  onCreate,
  onRetryCreate,
  onSelectTask,
  onStart,
}: {
  tasks: Task[];
  runs: Run[];
  projects: ProjectSummary[];
  projectsLoading: boolean;
  projectsLoaded: boolean;
  projectsError: string;
  onRetryProjects: () => void;
  loading: boolean;
  error: string;
  runsAvailable: boolean;
  onRetry: () => void;
  busy: boolean;
  title: string;
  detail: string;
  projectId: string;
  pendingTaskCreate: TaskCreateOperation | null;
  selectedTask: Task | null;
  ownerId: string;
  csrfToken: string;
  onSessionExpired: (cause: unknown) => boolean;
  onTaskUpdated: (task: Task) => void;
  onRunAdmitted: (run: Run) => void;
  onTitle: (value: string) => void;
  onDetail: (value: string) => void;
  onProjectId: (value: string) => void;
  onInvalidProjectId: () => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onRetryCreate: () => void;
  onSelectTask: (task: Task) => void;
  onStart: (task: Task, trigger: HTMLButtonElement) => void;
}) {
  const selectedTaskProject = selectedTask?.projectId
    ? projects.find((item) => item.id === selectedTask.projectId)
    : undefined;
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
              readOnly={pendingTaskCreate !== null}
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
              readOnly={pendingTaskCreate !== null}
              required
              rows={3}
            />
            <label htmlFor="task-project">Project</label>
            <select
              id="task-project"
              value={projectId}
              onChange={(event) => {
                const value = event.target.value;
                if (value === '' || ProjectIdSchema.safeParse(value).success) onProjectId(value);
                else onInvalidProjectId();
              }}
              disabled={pendingTaskCreate !== null || !projectsLoaded || projectsLoading}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name} ({project.key})
                </option>
              ))}
            </select>
            {projectsLoading && <small role="status">Loading projects…</small>}
            {!projectsLoading && !projectsLoaded && !projectsError && (
              <button type="button" onClick={onRetryProjects}>
                Load available projects
              </button>
            )}
            {projectsLoaded && projects.length === 0 && (
              <small>No active projects are available.</small>
            )}
            {projectsError && (
              <div className="task-project-error" role="status">
                <span>{projectsError} Tasks can still be created without a project.</span>
                <button type="button" onClick={onRetryProjects}>
                  Retry projects
                </button>
              </div>
            )}
            {pendingTaskCreate && (
              <p className="task-project-error" role="status">
                The previous project task request has an unknown outcome. Retry the exact saved
                request to check it safely; Omnis OS will not resend it automatically.
              </p>
            )}
            <div className="composer-footer">
              <span>Mock runs are synthetic. Project tasks are idempotent.</span>
              <button
                className="primary-button"
                type={pendingTaskCreate ? 'button' : 'submit'}
                disabled={busy}
                onClick={pendingTaskCreate ? onRetryCreate : undefined}
              >
                <Plus size={16} /> {pendingTaskCreate ? 'Retry same request' : 'Create task'}
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
            {selectedTask.status === 'in_review' &&
              (isAwaitingOwnerReview(selectedTask, runs) ? (
                <p className="task-review-note" role="status">
                  Awaiting your review. Open the task&apos;s latest run in Runs to accept its
                  result.
                </p>
              ) : (
                <p className="task-review-note" role="status">
                  An owner receipt for run {selectedTask.resultAcceptance?.runId} already exists,
                  but the task still reads in review. This is not awaiting your review; open its
                  latest run in Runs to reload the current state.
                </p>
              ))}
            {selectedTask.status === 'completed' && selectedTask.resultAcceptance && (
              <p className="task-review-note task-review-accepted">
                Owner accepted run {selectedTask.resultAcceptance.runId} on{' '}
                {formatDate(selectedTask.resultAcceptance.acceptedAt)} PHT.
              </p>
            )}
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
                <dt>Project</dt>
                <dd>
                  {selectedTask.projectId
                    ? selectedTaskProject
                      ? `${selectedTaskProject.name} (${selectedTaskProject.key})`
                      : selectedTask.projectId
                    : 'No project'}
                </dd>
              </div>
              <div>
                <dt>Related runs</dt>
                <dd>{runs.filter((run) => run.taskId === selectedTask.id).length}</dd>
              </div>
            </dl>
            <TaskExecutionAssignmentEditor
              task={selectedTask}
              csrfToken={csrfToken}
              onSessionExpired={onSessionExpired}
              onTaskUpdated={onTaskUpdated}
            />
            <SyntheticConnectorRunAction
              ownerId={ownerId}
              task={selectedTask}
              project={selectedTaskProject}
              csrfToken={csrfToken}
              onSessionExpired={onSessionExpired}
              onRunAdmitted={onRunAdmitted}
            />
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

type AcceptanceBindings = {
  ownerId: string;
  csrfToken: string;
  onAccepted: (task: Task) => void;
  onSessionExpired: (cause: unknown) => boolean;
  gate: { phase: 'idle' | 'refreshing' | 'failed' | 'done'; runId: string | null };
  onConflict: (runId: string) => void;
  onReload: (runId: string) => void;
  getSessionGeneration: () => number;
};

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
  onRetryStream,
  announcement,
  onSelectRun,
  onStop,
  onClearRun,
  acceptance,
}: {
  acceptance: AcceptanceBindings;
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
  onRetryStream: () => void;
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
        onRetryStream={onRetryStream}
        announcement={announcement}
        runs={runs}
        acceptance={acceptance}
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
  onRetryStream,
  announcement,
  runs,
  acceptance,
}: {
  runs: Run[];
  acceptance: AcceptanceBindings;
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
  onRetryStream: () => void;
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
          {streamState === 'paused' && (
            <div className="run-notice stream-paused-note">
              <p>
                Live updates are paused after repeated connection problems. The events shown are not
                updating.
              </p>
              <button type="button" className="secondary-button" onClick={onRetryStream}>
                Retry live updates
              </button>
            </div>
          )}
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
                    : streamState === 'paused'
                      ? 'Live updates are paused. Use Retry live updates to reconnect.'
                      : 'Waiting for run events…'}
            </div>
          )}
          {run.authorizationId && (
            <SyntheticAuditHistory taskId={run.taskId} authorizationId={run.authorizationId} />
          )}
          {run.status === 'completed' && (
            <div className="unverified-note">
              <Check size={15} />
              <p>This run completed. Its output remains synthetic and is not a verified result.</p>
            </div>
          )}
          {run.status === 'completed' && (
            <AcceptResultAction
              ownerId={acceptance.ownerId}
              task={task}
              run={run}
              runs={runs}
              csrfToken={acceptance.csrfToken}
              onAccepted={acceptance.onAccepted}
              onSessionExpired={acceptance.onSessionExpired}
              gate={acceptance.gate}
              onConflict={acceptance.onConflict}
              onReload={acceptance.onReload}
              getSessionGeneration={acceptance.getSessionGeneration}
            />
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
    paused: 'Updates paused',
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
