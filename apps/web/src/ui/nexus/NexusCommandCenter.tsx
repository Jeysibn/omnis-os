import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { LogOut, Plus, type LucideIcon } from 'lucide-react';
import type { Run, Task } from '@omnis/contracts';
import { AttentionPanel } from './AttentionPanel.js';
import { MissionLane } from './MissionLane.js';
import { PhtClock } from './PhtClock.js';
import { Reactor } from './Reactor.js';
import { VitalsPanel } from './VitalsPanel.js';
import { buildMissionEvents, countStreams, deriveLaneStatus } from './missionEvents.js';
import { useMissionStream } from './useMissionStream.js';
import { deriveReactorState } from './reactorState.js';
import { computeVitals, type LoadState } from './vitals.js';
import './nexus.css';

export type NexusNavItem = {
  id: 'command-center' | 'tasks' | 'runs' | 'agents';
  label: string;
  icon: LucideIcon;
};

export type NexusProps = {
  ownerName: string;
  navItems: NexusNavItem[];
  tasks: Task[];
  runs: Run[];
  tasksState: LoadState;
  runsState: LoadState;
  tasksError: string;
  runsError: string;
  busy: boolean;
  /** Global error from the application shell, shown inline so action failures stay visible. */
  notice: React.ReactNode;
  onSkip: (event: MouseEvent<HTMLAnchorElement>) => void;
  onSignOut: () => void;
  onRetryTasks: () => void;
  onRetryRuns: () => void;
  onNavigate: (page: 'tasks' | 'runs') => void;
  onOpenRun: (run: Run) => void;
  onStop: (run: Run) => void;
  onCreate: () => void;
  onReviewApproval: (task: Task, trigger: HTMLButtonElement) => void;
};

function connectionText(tasks: LoadState, runs: LoadState) {
  if (tasks === 'error' || runs === 'error') return 'API: a request failed';
  if (tasks === 'loading' || runs === 'loading') return 'API: checking';
  return 'API: responding';
}

export default function NexusCommandCenter(props: NexusProps) {
  const { tasks, runs, tasksState, runsState } = props;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  useEffect(() => {
    if (tasksState !== 'loading' && runsState !== 'loading') setLoadedAt(new Date());
  }, [tasks, runs, tasksState, runsState]);

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const state = useMemo(
    () =>
      deriveReactorState({
        tasksState,
        runsState,
        runs,
        tasks,
        pendingApprovals: null, // the API exposes no pending-approval list
        stream: 'not-applicable', // no event stream is held on this screen
        runtimeAvailable: undefined, // runtime health is not reported to the web app
      }),
    [tasksState, runsState, runs, tasks],
  );
  const vitals = useMemo(
    () => computeVitals({ tasks, runs, tasksState, runsState }),
    [tasks, runs, tasksState, runsState],
  );
  // Stale runs are never drawn as current activity: when the last refresh failed the reactor
  // receives no run markers at all (the readout already says so).
  const currentRuns = useMemo(() => (runsState === 'error' ? [] : runs), [runsState, runs]);
  const stream = useMissionStream(runs, runsState !== 'error', props.onRetryRuns);
  const events = useMemo(() => buildMissionEvents(stream.log, runs), [stream.log, runs]);
  const laneStatus = deriveLaneStatus({
    runs: stream.monitored,
    health: stream.health,
    eventCount: events.length,
    paused: runsState === 'error',
  });

  const focusApprovals = () => {
    const heading = document.getElementById('nx-approvals-heading');
    heading?.scrollIntoView({ block: 'nearest' });
    heading?.focus();
  };
  const refresh = () => {
    props.onRetryTasks();
    props.onRetryRuns();
    stream.reconnect();
  };
  const select = (runId: string) =>
    setSelectedRunId((current) => (current === runId ? null : runId));

  return (
    <div className="nexus" data-reactor-state={state.id}>
      <a className="skip-link nx-skip" href="#main-content" onClick={props.onSkip}>
        Skip to main content
      </a>
      <header className="nx-top">
        <a className="nx-brand" href="#command-center" aria-label="Omnis OS Nexus, Omnis OS home">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="9.5" fill="none" stroke="#91F2CD" strokeOpacity="0.6" />
            <circle cx="11" cy="11" r="3.2" fill="#91F2CD" />
          </svg>
          <span>
            OMNIS OS <i>/ NEXUS</i>
          </span>
        </a>
        <ul className="nx-status-strip" aria-label="Environment and connection">
          <li>
            <span className="nx-label">Env</span> Local workspace
          </li>
          <li>
            <span className="nx-label">Mode</span> Mock-only
          </li>
          <li data-problem={tasksState === 'error' || runsState === 'error'}>
            {connectionText(tasksState, runsState)}
          </li>
          <li>
            <span className="nx-label">Runtime</span> Mock adapter
          </li>
        </ul>
        <div className="nx-top-right">
          <button type="button" className="nx-btn" onClick={focusApprovals}>
            Approvals
          </button>
          <PhtClock />
          <span className="nx-owner">{props.ownerName}</span>
          <button
            type="button"
            className="nx-icon-btn"
            onClick={props.onSignOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <nav className="nx-rail" aria-label="Primary navigation">
        {props.navItems.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            aria-current={item.id === 'command-center' ? 'page' : undefined}
            className={item.id === 'command-center' ? 'is-active' : ''}
          >
            <item.icon size={18} aria-hidden="true" />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>

      <div className="nx-body">
        <VitalsPanel
          vitals={vitals}
          onOpenRuns={() => props.onNavigate('runs')}
          onOpenTasks={() => props.onNavigate('tasks')}
        />

        <main id="main-content" className="nx-stage" tabIndex={-1}>
          <div className="nx-stage-head">
            <span className="nx-label">Omnis Nexus</span>
            <h1>Command Center</h1>
          </div>
          {props.notice}
          <Reactor
            state={state}
            runs={currentRuns}
            selectedRunId={selectedRunId}
            onSelectRun={select}
          />
          <div className="nx-readout">
            <p className="nx-readout-label" role="status">
              {state.label}
            </p>
            <p className="nx-quiet">{state.detail}</p>
          </div>
          <div className="nx-deck" role="group" aria-label="Command deck">
            <button type="button" className="nx-primary" onClick={props.onCreate}>
              <Plus size={16} aria-hidden="true" /> Create task
            </button>
            <button type="button" className="nx-btn" onClick={() => props.onNavigate('runs')}>
              View runs
            </button>
            <button type="button" className="nx-btn" onClick={focusApprovals}>
              Review approvals
            </button>
            <span className="nx-unavailable">Private chat: not available yet</span>
          </div>
          <p className="nx-foot">
            Mock activity is synthetic and never provider activity. No model was contacted.
          </p>
        </main>

        <AttentionPanel
          tasks={tasks}
          runs={runs}
          tasksState={tasksState}
          runsState={runsState}
          tasksError={props.tasksError}
          runsError={props.runsError}
          busy={props.busy}
          selectedRun={selectedRun}
          onRetryTasks={props.onRetryTasks}
          onRetryRuns={props.onRetryRuns}
          onSelectRun={select}
          onClearSelection={() => setSelectedRunId(null)}
          onOpenRun={props.onOpenRun}
          onStop={props.onStop}
          onReviewApproval={props.onReviewApproval}
        />

        <MissionLane
          events={events}
          status={laneStatus}
          counts={countStreams(stream.monitored, stream.health)}
          monitoredCount={stream.monitored.length}
          totalRuns={runs.length}
          runsState={runsState}
          selectedRunId={selectedRunId}
          loadedAt={loadedAt}
          onSelectRun={select}
          onRefresh={refresh}
        />
      </div>
    </div>
  );
}
