import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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
  X,
} from 'lucide-react';
import {
  ApiErrorSchema,
  AuthorizationSchema,
  RunEventSchema,
  RunSchema,
  TaskSchema,
  type Run,
  type RunEvent,
  type Task,
} from '@omnis/contracts';

type Owner = { id: string; displayName: string };
type Page = 'command-center' | 'tasks' | 'runs';
type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'ended';

async function request<T>(
  path: string,
  init: RequestInit = {},
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
  });
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const error = ApiErrorSchema.safeParse(payload);
    throw new Error(
      error.success ? error.data.error.message : `Request failed (${response.status}).`,
    );
  }
  if (response.status === 204) return undefined as T;
  return parse(await response.json());
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [page, setPage] = useState<Page>(readPage);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [password, setPassword] = useState('');
  const [approvalTask, setApprovalTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState('');

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );

  const refreshCsrf = useCallback(async () => {
    const value = await request('/api/v1/auth/csrf', {}, (payload) => {
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('csrfToken' in payload) ||
        typeof payload.csrfToken !== 'string'
      )
        throw new Error('Could not start a secure session.');
      return payload.csrfToken;
    });
    setCsrfToken(value);
    return value;
  }, []);

  const loadWorkspace = useCallback(async () => {
    setLoadingData(true);
    try {
      const [taskData, runData] = await Promise.all([
        request('/api/v1/tasks', {}, parseTaskList),
        request('/api/v1/runs', {}, parseRunList),
      ]);
      setTasks(taskData);
      setRuns(runData);
      setSelectedRunId((current) =>
        current && runData.some((run) => run.id === current) ? current : (runData[0]?.id ?? null),
      );
      setSelectedTaskId((current) =>
        current && taskData.some((task) => task.id === current)
          ? current
          : (taskData[0]?.id ?? null),
      );
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => setPage(readPage());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refreshCsrf();
        const currentOwner = await request('/api/v1/me', {}, parseOwner);
        setOwner(currentOwner);
        await loadWorkspace();
      } catch (cause) {
        if (!(cause instanceof Error) || cause.message !== 'Sign in to continue.')
          setError(cause instanceof Error ? cause.message : 'Workspace could not be loaded.');
      } finally {
        setChecking(false);
      }
    })();
  }, [loadWorkspace, refreshCsrf]);

  useEffect(() => {
    if (!owner || !selectedRunId) {
      setEvents([]);
      setStreamState('closed');
      return;
    }
    setEvents([]);
    setStreamState('connecting');
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
          const parsed = RunEventSchema.parse(JSON.parse((message as MessageEvent<string>).data));
          setEvents((current) =>
            current.some((event) => event.sequence === parsed.sequence)
              ? current
              : [...current, parsed].sort((a, b) => a.sequence - b.sequence),
          );
          void request(`/api/v1/runs/${encodeURIComponent(selectedRunId)}`, {}, (value) =>
            RunSchema.parse(value),
          )
            .then((run) =>
              setRuns((current) => current.map((entry) => (entry.id === run.id ? run : entry))),
            )
            .catch(() => undefined);
          if (
            ['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(
              parsed.type,
            )
          ) {
            setStreamState('ended');
            source.close();
          }
        } catch {
          setError('A run event did not match the expected data format.');
        }
      };
      source.addEventListener(name, handler);
      return [name, handler] as const;
    });
    source.onerror = () =>
      setStreamState(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    return () => {
      handlers.forEach(([name, handler]) => source.removeEventListener(name, handler));
      source.close();
    };
  }, [owner, selectedRunId]);

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
      setError(cause instanceof Error ? cause.message : 'Sign in failed.');
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
          headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ title, detail }),
        },
        (value) => TaskSchema.parse(value),
      );
      setTasks((current) => [task, ...current]);
      setSelectedTaskId(task.id);
      setTitle('');
      setDetail('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Task could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function startRun(task: Task) {
    setBusy(true);
    setError('');
    try {
      const authorization = await request(
        '/api/v1/authorizations',
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ taskId: task.id }),
        },
        (value) => AuthorizationSchema.parse(value),
      );
      const decision = await request(
        `/api/v1/authorizations/${encodeURIComponent(authorization.id)}/decision`,
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken },
          body: JSON.stringify({ decision: 'approve' }),
        },
        (value) => AuthorizationSchema.parse(value),
      );
      const run = await request(
        '/api/v1/runs',
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken, 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ taskId: task.id, authorizationId: decision.id }),
        },
        (value) => RunSchema.parse(value),
      );
      setRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)]);
      setSelectedRunId(run.id);
      setEvents([]);
      setPage('runs');
      window.location.hash = 'runs';
      await loadWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Run could not be started.');
    } finally {
      setBusy(false);
      setApprovalTask(null);
    }
  }

  async function stopRun(run: Run) {
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
      setError(cause instanceof Error ? cause.message : 'Run could not be stopped.');
    } finally {
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
      await refreshCsrf();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign out failed.');
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
            <button
              className="primary-button auth-submit"
              type="submit"
              disabled={busy || !csrfToken}
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
    <div className="app-shell">
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
      <main className="main-content">
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
        {loadingData && (
          <div className="loading-note" role="status">
            Refreshing tasks and runs…
          </div>
        )}
        {page === 'command-center' && (
          <CommandCenter
            tasks={tasks}
            runs={runs}
            onNavigate={(destination) => navigate(destination, setPage)}
            onSelectRun={(run) => {
              setSelectedRunId(run.id);
              navigate('runs', setPage);
            }}
            onCreate={() => {
              navigate('tasks', setPage);
              window.setTimeout(() => document.getElementById('task-title')?.focus(), 0);
            }}
          />
        )}
        {page === 'tasks' && (
          <TasksWorkspace
            tasks={tasks}
            runs={runs}
            busy={busy}
            title={title}
            detail={detail}
            selectedTask={selectedTask}
            onTitle={setTitle}
            onDetail={setDetail}
            onCreate={createTask}
            onSelectTask={(task) => setSelectedTaskId(task.id)}
            onStart={(task) => setApprovalTask(task)}
          />
        )}
        {page === 'runs' && (
          <RunsWorkspace
            runs={runs}
            tasks={tasks}
            selectedRun={selectedRun}
            events={events}
            streamState={streamState}
            busy={busy}
            onSelectRun={(run) => setSelectedRunId(run.id)}
            onStop={(run) => void stopRun(run)}
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
          onCancel={() => setApprovalTask(null)}
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
];
const pageTitles: Record<Page, string> = {
  'command-center': 'Command Center',
  tasks: 'Tasks',
  runs: 'Runs',
};
const pageSubtitles: Record<Page, string> = {
  'command-center': 'Your operational overview for tasks and synthetic runs.',
  tasks: 'Create and review work in your local workspace.',
  runs: 'Follow current and historical mock run activity.',
};

function readPage(): Page {
  const value = window.location.hash.slice(1);
  return value === 'tasks' || value === 'runs' ? value : 'command-center';
}
function navigate(destination: Page, setPage: (page: Page) => void) {
  setPage(destination);
  if (window.location.hash !== `#${destination}`) window.location.hash = destination;
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

function CommandCenter({
  tasks,
  runs,
  onNavigate,
  onSelectRun,
  onCreate,
}: {
  tasks: Task[];
  runs: Run[];
  onNavigate: (page: Page) => void;
  onSelectRun: (run: Run) => void;
  onCreate: () => void;
}) {
  const recentTasks = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);
  const recentRuns = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  return (
    <div className="dashboard-grid">
      <section className="panel welcome-panel">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h2>Make the next task clear.</h2>
          <p>Track work from its first task record through each synthetic run and event.</p>
        </div>
        <button className="primary-button" onClick={onCreate}>
          <Plus size={16} /> New task
        </button>
      </section>
      <section className="panel dashboard-section">
        <div className="section-heading">
          <div>
            <h2>Recent tasks</h2>
            <p>Latest records in this workspace</p>
          </div>
          <button className="text-button" onClick={() => onNavigate('tasks')}>
            All tasks <ArrowRight size={14} />
          </button>
        </div>
        {recentTasks.length ? (
          <ul className="compact-list">
            {recentTasks.map((task) => (
              <li key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <span>{formatDate(task.createdAt)}</span>
                </div>
                <StatusPill status={task.status} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={<FilePlus2 size={18} />}
            title="No tasks yet"
            detail="Create a task to start a mock workflow."
            action={
              <button className="text-button" onClick={onCreate}>
                Create a task <ArrowRight size={14} />
              </button>
            }
          />
        )}
      </section>
      <section className="panel dashboard-section">
        <div className="section-heading">
          <div>
            <h2>Recent runs</h2>
            <p>Current and persisted run history</p>
          </div>
          <button className="text-button" onClick={() => onNavigate('runs')}>
            All runs <ArrowRight size={14} />
          </button>
        </div>
        {recentRuns.length ? (
          <ul className="compact-list">
            {recentRuns.map((run) => (
              <li key={run.id}>
                <button className="run-link" onClick={() => onSelectRun(run)}>
                  <span className="run-link-copy">
                    <strong>{run.taskTitle}</strong>
                    <span>{formatDate(run.createdAt)}</span>
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
            title="No runs yet"
            detail="Runs will appear after an owner approves a mock execution."
            action={
              <button className="text-button" onClick={() => onNavigate('tasks')}>
                Review tasks <ArrowRight size={14} />
              </button>
            }
          />
        )}
      </section>
    </div>
  );
}

function TasksWorkspace({
  tasks,
  runs,
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
  busy: boolean;
  title: string;
  detail: string;
  selectedTask: Task | null;
  onTitle: (value: string) => void;
  onDetail: (value: string) => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onSelectTask: (task: Task) => void;
  onStart: (task: Task) => void;
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
          {tasks.length === 0 ? (
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
                        onClick={() => onStart(task)}
                        disabled={busy || Boolean(activeRun)}
                        title={
                          activeRun
                            ? 'A run is already active for this task'
                            : 'Review and approve a synthetic mock run'
                        }
                      >
                        <Play size={15} />
                        <span>{activeRun ? 'In progress' : 'Approve & run'}</span>
                      </button>
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
  streamState,
  busy,
  onSelectRun,
  onStop,
}: {
  runs: Run[];
  tasks: Task[];
  selectedRun: Run | null;
  events: RunEvent[];
  streamState: StreamState;
  busy: boolean;
  onSelectRun: (run: Run) => void;
  onStop: (run: Run) => void;
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
        {runs.length ? (
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
            detail="Approved mock runs will appear here. The API currently exposes durable run history."
          />
        )}
      </section>
      <RunInspector
        run={selectedRun}
        tasks={tasks}
        events={events}
        streamState={streamState}
        busy={busy}
        onStop={onStop}
      />
    </div>
  );
}

function RunInspector({
  run,
  tasks,
  events,
  streamState,
  busy,
  onStop,
}: {
  run: Run | null;
  tasks: Task[];
  events: RunEvent[];
  streamState: StreamState;
  busy: boolean;
  onStop: (run: Run) => void;
}) {
  const task = run ? tasks.find((item) => item.id === run.taskId) : null;
  return (
    <aside className="panel run-inspector" aria-label="Run inspector">
      <div className="section-heading">
        <div>
          <h2>Run inspector</h2>
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
        <EmptyState
          icon={<Activity size={18} />}
          title="Select a run"
          detail="Choose a run from history to inspect its state and events."
        />
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
          {events.length ? (
            <ol className="event-list" aria-live="polite">
              {events.map((event) => (
                <EventRow key={event.id} event={event} />
              ))}
            </ol>
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
  onCancel,
  onApprove,
}: {
  task: Task;
  busy: boolean;
  onCancel: () => void;
  onApprove: () => void;
}) {
  useEffect(() => {
    const dialog = document.getElementById('approval-dialog') as HTMLDialogElement | null;
    if (dialog && !dialog.open) dialog.showModal();
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
          This approval is limited to the task below and the mock execution capability. It expires
          in 20 minutes and can be used once.
        </p>
        <div className="approval-task">
          <strong>{task.title}</strong>
          <span>{task.detail}</span>
        </div>
        <div className="dialog-foot">
          <button className="secondary-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary-button" onClick={onApprove} disabled={busy}>
            <ShieldCheck size={15} />
            {busy ? 'Starting…' : 'Approve & run'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export { App };
