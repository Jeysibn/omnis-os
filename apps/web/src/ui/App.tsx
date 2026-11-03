import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowRight,
  Check,
  CircleStop,
  Clock3,
  Command,
  FilePlus2,
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
    !('displayName' in value)
  ) {
    throw new Error('Owner session response is invalid.');
  }
  return { id: String(value.id), displayName: String(value.displayName) };
};

const parseTaskList = (value: unknown): Task[] => {
  if (!Array.isArray(value)) throw new Error('Task list response is invalid.');
  return value.map((item) => TaskSchema.parse(item));
};

const parseRunList = (value: unknown): Run[] => {
  if (!Array.isArray(value)) throw new Error('Run list response is invalid.');
  return value.map((item) => RunSchema.parse(item));
};

function statusLabel(status: Run['status']): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'stopping':
      return 'Stopping';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    case 'unknown':
      return 'Unknown';
  }
}

function App() {
  const [owner, setOwner] = useState<Owner | null>(null);
  const [checking, setChecking] = useState(true);
  const [csrfToken, setCsrfToken] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const refreshCsrf = useCallback(async () => {
    const value = await request('/api/v1/auth/csrf', {}, (payload) => {
      if (typeof payload !== 'object' || payload === null || !('csrfToken' in payload)) {
        throw new Error('Could not start a secure session.');
      }
      return String(payload.csrfToken);
    });
    setCsrfToken(value);
    return value;
  }, []);

  const loadWorkspace = useCallback(async () => {
    const [taskData, runData] = await Promise.all([
      request('/api/v1/tasks', {}, parseTaskList),
      request('/api/v1/runs', {}, parseRunList),
    ]);
    setTasks(taskData);
    setRuns(runData);
    setSelectedRunId((current) =>
      current && runData.some((run) => run.id === current) ? current : (runData[0]?.id ?? null),
    );
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refreshCsrf();
        const currentOwner = await request('/api/v1/me', {}, parseOwner);
        setOwner(currentOwner);
        await loadWorkspace();
      } catch (cause) {
        if (cause instanceof Error && cause.message !== 'Sign in to continue.')
          setError(cause.message);
      } finally {
        setChecking(false);
      }
    })();
  }, [loadWorkspace, refreshCsrf]);

  useEffect(() => {
    if (!owner || !selectedRunId) {
      setEvents([]);
      return;
    }
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
        } catch {
          setError('The run event did not match the expected schema.');
        }
      };
      source.addEventListener(name, handler);
      return [name, handler] as const;
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED)
        setError('Run event stream closed. Reload the workspace to reconnect.');
    };
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
          headers: {
            'x-omnis-csrf': csrfToken,
            'idempotency-key': crypto.randomUUID(),
          },
          body: JSON.stringify({ title, detail }),
        },
        (value) => TaskSchema.parse(value),
      );
      setTasks((current) => [task, ...current]);
      setTitle('');
      setDetail('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Task could not be created.');
    } finally {
      setBusy(false);
    }
  }

  async function startRun(task: Task) {
    const approved = window.confirm(
      `Approve the synthetic mock.execute capability for task “${task.title}” only? This approval expires in 20 minutes and can be used for one mock run.`,
    );
    if (!approved) return;
    setBusy(true);
    setError('');
    try {
      const authorization = await request(
        '/api/v1/authorizations',
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken },
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
      await loadWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Run could not be started.');
    } finally {
      setBusy(false);
    }
  }

  async function stopRun() {
    if (!selectedRun) return;
    setBusy(true);
    setError('');
    try {
      const run = await request(
        `/api/v1/runs/${encodeURIComponent(selectedRun.id)}/stop`,
        {
          method: 'POST',
          headers: { 'x-omnis-csrf': csrfToken },
        },
        (value) => RunSchema.parse(value),
      );
      setRuns((current) => current.map((entry) => (entry.id === run.id ? run : entry)));
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
      <main className="loading-screen">
        <span className="loading-mark">
          <Command size={22} />
        </span>
        <p>Opening Omnis OS…</p>
      </main>
    );
  if (!owner) {
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
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className="nav-active" href="#command-center">
            <Activity size={16} /> <span>Command Center</span>
          </a>
        </nav>
        <div className="topbar-actions">
          <div className="owner-chip">
            <span className="owner-avatar">D</span>
            <span>{owner.displayName}</span>
          </div>
          <button className="icon-button" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={17} />
          </button>
        </div>
      </header>

      <main id="command-center" className="main-content">
        <section className="page-heading">
          <div>
            <div className="heading-row">
              <h1>Command Center</h1>
              <span className="mock-badge">
                <Sparkles size={13} /> Mock-only mode
              </span>
            </div>
            <p>Every task has a source, every run has a trail.</p>
          </div>
          <div className="local-status">
            <span className="status-dot" /> Local workspace <span className="status-divider" /> One
            run at a time
          </div>
        </section>

        {error && <ErrorNote message={error} onDismiss={() => setError('')} />}

        <section className="workspace-grid" aria-label="Mock run workspace">
          <div className="work-column">
            <div className="section-heading">
              <div>
                <h2>Task queue</h2>
                <p>Create a task, then start its synthetic run.</p>
              </div>
              <span className="section-count">{tasks.length.toString().padStart(2, '0')}</span>
            </div>

            <form className="task-composer" onSubmit={createTask}>
              <div className="composer-title">
                <span className="composer-icon">
                  <FilePlus2 size={16} />
                </span>
                <h3>New task</h3>
                <span className="composer-caption">Local record</span>
              </div>
              <label className="sr-only" htmlFor="task-title">
                Task title
              </label>
              <input
                id="task-title"
                maxLength={120}
                minLength={3}
                placeholder="Give this task a clear outcome"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
              />
              <label className="sr-only" htmlFor="task-detail">
                Task detail
              </label>
              <textarea
                id="task-detail"
                maxLength={2000}
                minLength={10}
                placeholder="Describe the read-only work you want to inspect…"
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
                required
                rows={3}
              />
              <div className="composer-footer">
                <span>Runs in this gate are synthetic.</span>
                <button className="primary-button" type="submit" disabled={busy}>
                  <Plus size={16} /> Create task
                </button>
              </div>
            </form>

            <div className="task-list-heading">
              <h3>Open work</h3>
              <span>
                {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
              </span>
            </div>
            {tasks.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">
                  <FilePlus2 size={19} />
                </span>
                <strong>No tasks yet</strong>
                <p>Add one above to begin the mock lifecycle.</p>
              </div>
            ) : (
              <ul className="task-list">
                {tasks.map((task) => {
                  const activeRun = runs.find(
                    (run) =>
                      run.taskId === task.id &&
                      ['queued', 'running', 'stopping'].includes(run.status),
                  );
                  return (
                    <li className="task-row" key={task.id}>
                      <div className="task-mark">
                        <span className={`task-state state-${task.status}`} />
                      </div>
                      <div className="task-copy">
                        <strong>{task.title}</strong>
                        <p>{task.detail}</p>
                        <span className="task-meta">
                          {task.id} <span>·</span> {task.status.replace('_', ' ')}
                        </span>
                      </div>
                      <button
                        className="run-task-button"
                        onClick={() => void startRun(task)}
                        disabled={busy || Boolean(activeRun)}
                        aria-label={`Start mock run for ${task.title}`}
                        title={
                          activeRun
                            ? 'A run is already active'
                            : 'Approve and start one synthetic mock run'
                        }
                      >
                        {activeRun ? <Clock3 size={16} /> : <Play size={16} />}
                        <span>{activeRun ? 'In progress' : 'Approve & run mock'}</span>
                        {!activeRun && <ArrowRight size={14} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <aside className="run-panel" aria-label="Run inspector">
            <div className="run-panel-top">
              <div>
                <h2>Run inspector</h2>
                <p>Ordered events · reconnectable stream</p>
              </div>
              <span className="stream-indicator">
                <span /> SSE
              </span>
            </div>
            {!selectedRun ? (
              <div className="run-empty">
                <span className="empty-icon">
                  <Activity size={19} />
                </span>
                <strong>No run selected</strong>
                <p>Start a mock run to inspect its lifecycle.</p>
              </div>
            ) : (
              <>
                <div className="run-summary">
                  <div className="run-summary-line">
                    <span className={`run-status status-${selectedRun.status}`}>
                      <span />
                      {statusLabel(selectedRun.status)}
                    </span>
                    <span className="runtime-kind">MOCK RUNTIME</span>
                  </div>
                  <h3>{selectedRun.taskTitle}</h3>
                  <div className="run-id-line">
                    <span>{selectedRun.id}</span>
                    <span>Usage unknown</span>
                  </div>
                  {['queued', 'running', 'stopping'].includes(selectedRun.status) && (
                    <button
                      className="stop-button"
                      onClick={() => void stopRun()}
                      disabled={busy || selectedRun.status === 'stopping'}
                    >
                      <CircleStop size={15} />{' '}
                      {selectedRun.status === 'stopping' ? 'Waiting for stop' : 'Request stop'}
                    </button>
                  )}
                </div>
                <div className="event-heading">
                  <h3>Event trail</h3>
                  <span>
                    {events.length} {events.length === 1 ? 'event' : 'events'}
                  </span>
                </div>
                <ol className="event-list" aria-live="polite">
                  {events.map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))}
                  {events.length === 0 && (
                    <li className="event-placeholder">
                      <Clock3 size={15} /> Waiting for the first event…
                    </li>
                  )}
                </ol>
                {selectedRun.status === 'completed' && (
                  <div className="unverified-note">
                    <X size={15} />
                    <p>Mock output is synthetic and cannot be accepted as a verified result.</p>
                  </div>
                )}
              </>
            )}
          </aside>
        </section>
        <footer className="page-foot">
          <ShieldCheck size={14} />
          <span>Mock activity is never provider activity. No model was contacted.</span>
          <span className="foot-divider" />
          <span>Task and run history persists across API and worker restarts.</span>
        </footer>
      </main>
    </div>
  );
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

function EventRow({ event }: { event: RunEvent }) {
  const terminal = ['run.completed', 'run.cancelled', 'run.failed', 'run.interrupted'].includes(
    event.type,
  );
  return (
    <li className={`event-row ${terminal ? 'event-terminal' : ''}`}>
      <span className={`event-marker marker-${event.type.split('.')[1]}`}>
        {terminal && event.type === 'run.completed' ? <Check size={12} /> : <span />}
      </span>
      <div className="event-body">
        <div className="event-title">
          <strong>{event.type.replace('run.', '').replaceAll('_', ' ')}</strong>
          <time dateTime={event.at}>
            {new Date(event.at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>
        </div>
        <p>{event.message}</p>
        <span className="event-source">{event.id} · mock source · synthetic</span>
      </div>
    </li>
  );
}

export { App };
