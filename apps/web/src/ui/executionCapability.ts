import type { RuntimeCapabilities } from '@omnis/contracts/runtime-capabilities';

/** What the owner can currently do about execution, derived only from the backend contract. */
export type ExecutionGateKind =
  | 'loading'
  | 'load_failed'
  | 'disabled'
  | 'worker_unavailable'
  | 'authorizer_unavailable'
  | 'mode_mismatch'
  | 'unavailable'
  | 'mock_ready';

export type ExecutionGate = {
  kind: ExecutionGateKind;
  /** True only when the backend reports mock execution as available. Never the security boundary. */
  canStartRun: boolean;
  title: string;
  detail: string;
};

export type CapabilityLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; capabilities: RuntimeCapabilities };

export function describeExecution(load: CapabilityLoad): ExecutionGate {
  if (load.status === 'loading')
    return {
      kind: 'loading',
      canStartRun: false,
      title: 'Checking execution capability…',
      detail: 'Runs stay unavailable until Omnis OS confirms what this deployment can execute.',
    };
  if (load.status === 'error')
    return {
      kind: 'load_failed',
      canStartRun: false,
      title: 'Execution capability unknown',
      detail: `${load.message} No Run can be started until this is confirmed. Existing Runs are unaffected.`,
    };
  const { execution, services, authorization } = load.capabilities;
  if (services.worker === 'unavailable')
    return {
      kind: 'worker_unavailable',
      canStartRun: false,
      title: 'Execution service unavailable',
      detail:
        'The Omnis OS worker is not responding, so its execution state cannot be confirmed. Existing Runs keep their recorded state.',
    };
  if (execution.availability === 'disabled')
    return {
      kind: 'disabled',
      canStartRun: false,
      title: 'Execution is disabled',
      detail:
        'This deployment is configured not to execute Runs. Nothing is simulated, queued, or approved here. Projects, Agent Profiles, Tasks, and past Runs remain available.',
    };
  if (execution.availability === 'available')
    return {
      kind: 'mock_ready',
      canStartRun: true,
      title: 'Synthetic mock execution available',
      detail:
        'Runs use a local synthetic runtime only. They are labelled mock and never contact a real provider.',
    };
  // Remaining case: worker is healthy but execution is unavailable. Attribute it in order of
  // precedence: mode disagreement, then queue/launcher, then the Authorizer; never imply availability.
  const authDown = authorization.availability === 'unavailable';
  const authNote = authDown ? ' Owner approvals are also unavailable.' : '';
  if (execution.workerMode !== execution.configuredMode)
    return {
      kind: 'mode_mismatch',
      canStartRun: false,
      title: 'Execution mode mismatch',
      detail: `The API and worker disagree on the execution mode, so execution is unavailable.${authNote}`,
    };
  const queueDown = execution.queueAvailability !== 'available';
  const launcherDown = execution.launcherAvailability !== 'available';
  if (queueDown || launcherDown)
    return {
      kind: 'unavailable',
      canStartRun: false,
      title: 'Execution temporarily unavailable',
      detail: `The execution ${queueDown && launcherDown ? 'queue and launcher are' : queueDown ? 'queue is' : 'launcher is'} not ready, so no Run can start.${authNote} Try again shortly.`,
    };
  if (authDown)
    return {
      kind: 'authorizer_unavailable',
      canStartRun: false,
      title: 'Approval service unavailable',
      detail:
        'Owner approvals cannot be created or verified right now, so no Run can start. Execution itself is not disabled.',
    };
  return {
    kind: 'unavailable',
    canStartRun: false,
    title: 'Execution temporarily unavailable',
    detail: 'Omnis OS reports execution as unavailable. Try again shortly.',
  };
}

/** Whether the synthetic connector fixture may be offered; requires the backend's explicit flag. */
export function syntheticFixtureOffered(load: CapabilityLoad): boolean {
  return (
    load.status === 'ready' &&
    describeExecution(load).canStartRun &&
    load.capabilities.syntheticConnectorFixture.enabled
  );
}

/** Fixture gate for a freshly fetched result, so handlers never read stale React state. */
export function fixtureAllowed(capabilities: RuntimeCapabilities | null): boolean {
  return capabilities !== null && syntheticFixtureOffered({ status: 'ready', capabilities });
}
