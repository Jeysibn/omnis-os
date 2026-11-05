import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { Run } from '@omnis/contracts';
import {
  buildConstellation,
  hashString,
  mulberry32,
  orbitPoint,
  ORBITS,
} from './nexus/geometry.js';
import { laneStatusText } from './nexus/MissionLane.js';
import {
  addRunEvent,
  buildMissionEvents,
  countStreams,
  deriveLaneStatus,
  type StreamHealth,
  MAX_EVENTS_PER_RUN,
  MAX_STREAMS,
  pruneRunEvents,
  selectMonitoredRuns,
  type RunEventLog,
} from './nexus/missionEvents.js';
import { deriveReactorState, type ReactorInput } from './nexus/reactorState.js';
import { formatManilaStamp } from './nexus/time.js';
import { computeVitals } from './nexus/vitals.js';
import { csrf, mockApi, run, runEvent, task, T0, type NexusApiOptions } from './nexusFixture.js';
import { defaultRunEvents } from './nexusFixture.js';
import { fake, installFakeEventSource } from './nexusFakeEventSource.js';

const shotDir = process.env.NEXUS_SHOT_DIR;
if (shotDir) mkdirSync(shotDir, { recursive: true });

async function open(page: Page, options: NexusApiOptions = {}) {
  const api = await mockApi(page, options);
  await page.goto('/#command-center');
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
  return api;
}
const readout = (page: Page) => page.locator('.nx-readout-label');

async function axe(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const summary = results.violations
    .filter((v) => v.impact === 'critical' || v.impact === 'serious')
    .flatMap((v) =>
      v.nodes.map(
        (n) => `${v.id} ${n.target.join(' ')} :: ${n.any[0]?.message ?? n.failureSummary ?? ''}`,
      ),
    );
  expect(summary).toEqual([]);
}

// ---------------------------------------------------------------- pure logic
const base: ReactorInput = {
  tasksState: 'ready',
  runsState: 'ready',
  runs: [],
  tasks: [],
  pendingApprovals: null,
  stream: 'not-applicable',
  runtimeAvailable: undefined,
};

test.describe('reactor state derivation', () => {
  const r = (id: string, status: Parameters<typeof run>[3], updatedAt = T0) =>
    run(id, 't', 'x', status, updatedAt);
  test('maps authoritative data to one labelled state with the specified precedence', () => {
    const label = (input: Partial<ReactorInput>) => deriveReactorState({ ...base, ...input }).label;
    expect(label({})).toBe('Idle');
    expect(label({ tasksState: 'loading' })).toBe('Loading system state');
    expect(label({ runsState: 'error' })).toBe('System state unavailable');
    expect(label({ runs: [r('a', 'running')] })).toBe('Mock execution active');
    expect(label({ runs: [r('a', 'stopping')] })).toBe('Mock execution active');
    expect(label({ runs: [r('a', 'queued')] })).toBe('Queued');
    expect(label({ runs: [r('a', 'failed')] })).toBe('Run failed');
    expect(label({ runs: [r('a', 'interrupted')] })).toBe('Run failed');
    expect(label({ runs: [r('a', 'cancelled')] })).toBe('Canceled');
    expect(label({ runs: [r('a', 'completed')] })).toBe('Idle');
    expect(label({ pendingApprovals: 1, runs: [r('a', 'running')] })).toBe('Approval required');
    expect(label({ stream: 'disconnected', pendingApprovals: 1 })).toBe(
      'Live updates disconnected',
    );
    expect(label({ runtimeAvailable: false, stream: 'disconnected' })).toBe('Runtime unavailable');
  });
  test('only the most recent run decides the failed or canceled state', () => {
    const runs = [
      r('old', 'failed', '2026-11-03T01:00:00.000Z'),
      r('new', 'completed', '2026-11-03T03:00:00.000Z'),
    ];
    expect(deriveReactorState({ ...base, runs }).id).toBe('idle');
  });
  test('never invents approval, runtime or stream state from absent evidence', () => {
    const state = deriveReactorState({
      ...base,
      pendingApprovals: null,
      runtimeAvailable: undefined,
    });
    expect(['approval', 'runtime-unavailable', 'disconnected']).not.toContain(state.id);
  });
  test('failed state carries a one-shot cue and approval stays localized in amber', () => {
    expect(deriveReactorState({ ...base, runs: [r('a', 'failed')] }).visual).toMatchObject({
      tint: 'red',
      cue: true,
    });
    expect(deriveReactorState({ ...base, pendingApprovals: 2 }).visual.tint).toBe('amber');
    expect(deriveReactorState({ ...base, stream: 'disconnected' }).visual.speed).toBe(0);
  });
});

test.describe('vitals', () => {
  test('shows no count unless the source confirmed it; zero is a confirmed zero', () => {
    const loading = computeVitals({
      tasks: [],
      runs: [],
      tasksState: 'loading',
      runsState: 'error',
    });
    expect(loading.activeRuns.value).toBeNull();
    expect(loading.openTasks.value).toBeNull();
    expect(loading.lastRecordAt).toBeNull();
    const ready = computeVitals({ tasks: [], runs: [], tasksState: 'ready', runsState: 'ready' });
    expect(ready.activeRuns.value).toBe(0);
    expect(ready.failedRuns.value).toBe(0);
  });
  test('counts by status', () => {
    const v = computeVitals({
      tasks: [task('a', 'A'), task('b', 'B', 'completed')],
      runs: [
        run('1', 'a', 'A', 'running'),
        run('2', 'a', 'A', 'queued'),
        run('3', 'a', 'A', 'failed'),
        run('4', 'a', 'A', 'interrupted'),
      ],
      tasksState: 'ready',
      runsState: 'ready',
    });
    expect([v.activeRuns.value, v.queuedRuns.value, v.openTasks.value, v.failedRuns.value]).toEqual(
      [1, 1, 1, 2],
    );
  });
});

test.describe('mission events and time', () => {
  const at = (minute: number) => `2026-11-03T02:${String(minute).padStart(2, '0')}:00.000Z`;
  const fold = (events: ReturnType<typeof runEvent>[]) =>
    events.reduce<RunEventLog>((log, event) => addRunEvent(log, event), {});

  test('replayed events are de-duplicated and out-of-order arrivals are sequenced', () => {
    const e1 = runEvent('a', 1, 'run.queued', at(1));
    const e2 = runEvent('a', 2, 'run.started', at(2));
    const e3 = runEvent('a', 3, 'run.stop_requested', at(3));
    const log = fold([e1, e3, e2, e1, e2, e3]); // out of order, then a full replay
    expect(log['a']!.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(addRunEvent(log, e2)).toBe(log); // a duplicate is a no-op, same reference
  });

  test('lane nodes are ordered by time, then run, then sequence, and omit output lines', () => {
    const runs = [run('a', 't', 'Alpha', 'running'), run('b', 't', 'Bravo', 'completed')];
    const log = fold([
      runEvent('b', 1, 'run.queued', at(2)),
      runEvent('a', 2, 'run.output', at(4)),
      runEvent('a', 1, 'run.queued', at(1)),
      runEvent('b', 2, 'run.completed', at(5)),
      runEvent('a', 3, 'run.started', at(3)),
    ]);
    const nodes = buildMissionEvents(log, runs);
    expect(nodes.map((n) => n.id)).toEqual(['a:1', 'b:1', 'a:3', 'b:2']);
    expect(nodes.map((n) => n.label)).toEqual(['Queued', 'Queued', 'Started', 'Completed']);
    expect(nodes.every((n) => n.label !== 'Output')).toBe(true);
  });

  test('history is bounded per run and pruned for runs that are no longer followed', () => {
    let log: RunEventLog = {};
    log = addRunEvent(log, runEvent('a', 1, 'run.queued', at(1)));
    for (let i = 2; i <= MAX_EVENTS_PER_RUN + 25; i++)
      log = addRunEvent(log, runEvent('a', i, 'run.output', at(2)));
    log = addRunEvent(log, runEvent('a', 999, 'run.completed', at(9)));
    const kept = log['a']!;
    expect(kept.length).toBe(MAX_EVENTS_PER_RUN);
    expect(kept[0]!.type).toBe('run.queued'); // lifecycle events survive output trimming
    expect(kept.at(-1)!.type).toBe('run.completed');
    expect(
      pruneRunEvents({ ...log, b: [runEvent('b', 1, 'run.queued', at(1))] }, new Set(['a'])),
    ).not.toHaveProperty('b');
  });

  test('only a bounded set of runs is followed, unfinished first', () => {
    const runs = [
      run('done-new', 't', 'D', 'completed', at(50)),
      ...Array.from({ length: 5 }, (_, i) => run(`live-${i}`, 't', 'L', 'running', at(i))),
    ];
    const picked = selectMonitoredRuns(runs).map((r) => r.id);
    expect(picked).toHaveLength(MAX_STREAMS);
    expect(picked).not.toContain('done-new');
    expect(picked[0]).toBe('live-4');
  });

  test('lane status aggregates every followed stream', () => {
    const a = run('a', 't', 'A', 'running');
    const b = run('b', 't', 'B', 'running');
    const done = run('d', 't', 'D', 'completed');
    type H = Record<string, StreamHealth>;
    const d = (runs: (typeof a)[], health: H, eventCount = 2, paused = false) =>
      deriveLaneStatus({ runs, health, eventCount, paused });
    expect(d([a, b], { a: 'open', b: 'open' })).toBe('live'); // two live streams
    expect(d([a, b], { a: 'open', b: 'reconnecting' })).toBe('partial');
    expect(d([a, b], { a: 'open', b: 'exhausted' })).toBe('partial');
    expect(d([a, b], { a: 'open', b: 'failed' })).toBe('partial');
    expect(d([a, b], { a: 'reconnecting', b: 'reconnecting' })).toBe('reconnecting');
    expect(d([a, b], { a: 'exhausted', b: 'exhausted' })).toBe('exhausted'); // all failed
    expect(d([a, b], { a: 'exhausted', b: 'exhausted' }, 0)).toBe('unavailable');
    expect(d([a, done], { a: 'open', d: 'ended' })).toBe('live'); // a normal end is not a failure
    expect(d([a, done], { a: 'open', d: 'exhausted' })).toBe('partial'); // a failed history load is
    expect(d([done], { d: 'ended' })).toBe('history'); // all completed: no live stream needed
    expect(d([done], { d: 'open' })).toBe('loading'); // replay in progress is not live
    expect(d([done], { d: 'exhausted' })).toBe('exhausted');
    expect(d([a], { a: 'connecting' }, 0)).toBe('loading');
    expect(d([a, b], { a: 'suspended', b: 'suspended' })).toBe('paused');
    expect(d([a], { a: 'open' }, 2, true)).toBe('disconnected'); // run list unavailable
    expect(d([], {}, 0)).toBe('empty');
    expect(countStreams([a, b, done], { a: 'open', b: 'reconnecting', d: 'ended' })).toEqual({
      unfinished: 2,
      live: 1,
      reconnecting: 1,
      exhausted: 0,
    });
    expect(laneStatusText('live', { unfinished: 2, live: 2, reconnecting: 0, exhausted: 0 })).toBe(
      'Live: receiving updates for all 2 unfinished runs.',
    );
    expect(
      laneStatusText('partial', { unfinished: 2, live: 1, reconnecting: 0, exhausted: 1 }),
    ).toBe(
      'Partially connected: 1 of 2 unfinished runs live, 1 stopped after retries. Loaded history is kept.',
    );
  });
  test('formats timestamps in Asia/Manila regardless of host timezone', () => {
    expect(formatManilaStamp('2026-11-03T02:00:00.000Z')).toContain('10:00:00');
    expect(formatManilaStamp('2026-11-03T16:30:00.000Z')).toContain('00:30:00'); // next day, UTC+8
  });
});

test.describe('constellation geometry', () => {
  test('is deterministic, asymmetric and connected without self-links', () => {
    const a = buildConstellation({ primary: 200, shell: 50 });
    const b = buildConstellation({ primary: 200, shell: 50 });
    expect(Array.from(a.pos)).toEqual(Array.from(b.pos));
    expect(a.edges.length).toBeGreaterThan(200);
    for (let i = 0; i < a.edges.length; i += 2) expect(a.edges[i]).not.toBe(a.edges[i + 1]);
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < a.count; i++) {
      cx += a.pos[i * 3]!;
      cy += a.pos[i * 3 + 1]!;
    }
    expect(Math.hypot(cx, cy) / a.count).toBeGreaterThan(0.02); // lopsided, not a centered globe
  });
  test('orbits are distinct planes and the hash is stable', () => {
    const tilts = new Set(ORBITS.map((o) => `${o.tiltX}:${o.tiltZ}`));
    expect(tilts.size).toBe(ORBITS.length);
    expect(orbitPoint(ORBITS[0]!, 0)).toHaveLength(3);
    expect(hashString('run-1')).toBe(hashString('run-1'));
    expect(hashString('run-1')).not.toBe(hashString('run-2'));
    expect(mulberry32(1)()).toBe(mulberry32(1)());
  });
});

// ---------------------------------------------------------------- interface
test('renders the cinematic shell with landmarks, live data and a canvas reactor', async ({
  page,
}) => {
  await open(page);
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'System vitals' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Requires attention' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Mission lane' })).toBeVisible();
  await expect(page.locator('canvas.reactor-canvas')).toBeVisible();
  await expect(page.locator('.reactor')).toHaveAttribute('data-reactor-mode', 'animated');
  await expect(readout(page)).toHaveText('Mock execution active');
  await expect(
    page.getByText('Mock activity is synthetic and never provider activity.'),
  ).toBeVisible();
  await expect(page.locator('.nx-clock time')).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  await expect(page.getByText('Local workspace').first()).toBeVisible();
});

test('vitals come from real records and link to their source', async ({ page }) => {
  await open(page);
  const vitals = page.getByRole('complementary', { name: 'System vitals' });
  await expect(vitals.getByRole('button', { name: /^Active runs:\s*1/ })).toBeVisible();
  await expect(vitals.getByRole('button', { name: /^Open tasks:\s*2/ })).toBeVisible();
  await expect(vitals.getByRole('button', { name: /^Failed or interrupted:\s*1/ })).toBeVisible();
  await vitals.getByRole('button', { name: /^Open tasks/ }).click();
  await expect(page).toHaveURL(/#tasks$/);
});

for (const [name, runs, expected] of [
  ['idle', [run('r1', 't', 'Done run', 'completed')], 'Idle'],
  ['queued', [run('r1', 't', 'Waiting run', 'queued')], 'Queued'],
  ['failed', [run('r1', 't', 'Broken run', 'failed')], 'Run failed'],
  ['canceled', [run('r1', 't', 'Stopped run', 'cancelled')], 'Canceled'],
] as const) {
  test(`reactor reflects ${name} runs and keeps the state readable as text`, async ({ page }) => {
    await open(page, { runs: [...runs] });
    await expect(readout(page)).toHaveText(expected);
    await expect(page.locator('.nx-readout .nx-quiet')).not.toBeEmpty();
  });
}

test('loading state is static and honest, then resolves', async ({ page }) => {
  await mockApi(page, { taskDelayMs: 800 });
  await page.goto('/#command-center');
  await expect(readout(page)).toHaveText('Loading system state');
  await expect(readout(page)).toHaveText('Mock execution active');
});

test('a failed runs request shows Unavailable, never zero or an empty state', async ({ page }) => {
  await open(page, { runFailures: 1 });
  await expect(readout(page)).toHaveText('System state unavailable');
  await expect(page.getByText('Runs unavailable')).toBeVisible();
  await expect(page.getByText('No runs recorded')).toHaveCount(0);
  const active = page.getByRole('button', { name: /^Active runs/ });
  await expect(active).toContainText('Unavailable');
  await expect(active).not.toContainText(/Active runs:\s*0/);
  await expect(page.getByText(/Mission records are unavailable/)).toBeVisible();
  await page.getByRole('button', { name: 'Retry runs' }).first().click();
  await expect(readout(page)).toHaveText('Mock execution active');
  await expect(page.getByText('Runs unavailable')).toHaveCount(0);
});

test('a failed tasks request is reported where approvals would be', async ({ page }) => {
  await open(page, { taskFailures: 1 });
  await expect(page.getByText('Tasks unavailable')).toBeVisible();
  await expect(page.getByText('No tasks yet')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry tasks' }).first().click();
  await expect(
    page.getByRole('button', { name: /Review approval to start Review launch checklist/ }),
  ).toBeVisible();
});

test('approval review opens the existing secure dialog and makes no request on cancel', async ({
  page,
}) => {
  const api = await open(page);
  const before = api.requests.length;
  await page
    .getByRole('button', { name: /Review approval to start Review launch checklist/ })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Approve one synthetic run?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(api.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
  await expect(
    page.getByRole('button', { name: /Review approval to start Review launch checklist/ }),
  ).toBeFocused();
});

test('the reactor never authorizes: no non-GET request happens from canvas interaction', async ({
  page,
}) => {
  const api = await open(page);
  const box = (await page.locator('canvas.reactor-canvas').boundingBox())!;
  for (const [x, y] of [
    [0.5, 0.5],
    [0.3, 0.4],
    [0.7, 0.6],
  ] as const)
    await page.mouse.click(box.x + box.width * x, box.y + box.height * y);
  expect(api.requests.filter((r) => r.method !== 'GET' && !r.path.endsWith('/csrf'))).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('Request stop is single, sends CSRF once, and shows the requested state', async ({ page }) => {
  const api = await open(page);
  const stop = page.getByRole('button', { name: 'Request stop' });
  await expect(stop).toHaveCount(1);
  await stop.dblclick();
  await expect(page.getByRole('button', { name: 'Stop requested' })).toBeDisabled();
  const posts = api.requests.filter((r) => r.path.endsWith('/stop'));
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ method: 'POST', csrf });
});

test('stop failure is announced and retryable', async ({ page }) => {
  await open(page, { stopStatus: 503 });
  await page.getByRole('button', { name: 'Request stop' }).click();
  await expect(page.getByRole('alert')).toContainText('Stop request could not be completed.');
  await expect(page.getByRole('button', { name: 'Request stop' })).toBeEnabled();
  await page.getByRole('button', { name: 'Dismiss error' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('command deck routes through supported flows only', async ({ page }) => {
  await open(page);
  await expect(page.getByText('Private chat: not available yet')).toBeVisible();
  await expect(page.getByRole('button', { name: /private chat/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review approvals' }).click();
  await expect(page.locator('#nx-approvals-heading')).toBeFocused();
  await page.getByRole('button', { name: 'View runs' }).click();
  await expect(page).toHaveURL(/#runs$/);
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page).toHaveURL(/#tasks$/);
  await expect(page.getByLabel('Task title')).toBeFocused();
});

test('selecting a run focuses the inspector, marks the lane, and can return to the whole view', async ({
  page,
}) => {
  await open(page);
  const selected = page
    .getByRole('region', { name: 'Selected mission' })
    .or(page.locator('#nx-selected-h').locator('..'));
  await page
    .getByRole('button', { name: /Sync archive/ })
    .first()
    .click();
  await expect(selected).toContainText('Sync archive');
  await expect(selected).toContainText('Failed');
  await expect(selected).toContainText('Not reported');
  await expect(selected.getByText('run-bad')).toBeVisible();
  const laneNodes = page.locator('.nx-node[data-run="run-bad"]');
  await expect(laneNodes.first()).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Open run and event replay' }).click();
  await expect(page).toHaveURL(/#runs\/run-bad$/);
  await page.goBack();
  await page
    .getByRole('button', { name: /Sync archive/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Whole-system view' }).click();
  await expect(page.getByText(/Choose a run in a list/)).toBeVisible();
});

test('clicking a run marker on the reactor selects that run', async ({ page }) => {
  await open(page, { runs: [run('only', 't', 'Only run', 'completed')] });
  const canvas = page.locator('canvas.reactor-canvas');
  // Markers rest on their orbit; scan the canvas for the marker instead of guessing geometry.
  const scan = () =>
    canvas.evaluate((el: HTMLCanvasElement) => {
      const box = el.getBoundingClientRect();
      for (let y = 0.1; y < 0.95; y += 0.02) {
        for (let x = 0.05; x < 0.95; x += 0.02) {
          const clientX = box.left + box.width * x;
          const clientY = box.top + box.height * y;
          el.dispatchEvent(new PointerEvent('pointermove', { clientX, clientY, bubbles: true }));
          if (el.style.cursor === 'pointer') {
            el.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }));
            return true;
          }
        }
      }
      return false;
    });
  // markers only become hit-testable once the entrance sequence has drawn them
  await expect.poll(scan, { timeout: 10_000 }).toBe(true);
  await expect(page.locator('.nx-block[aria-labelledby="nx-selected-h"]')).toContainText(
    'Only run',
  );
});

test('mission lane is chronological, Manila-timed, pausable and expandable', async ({ page }) => {
  await open(page);
  const lane = page.getByRole('region', { name: 'Mission lane' });
  const times = lane.locator('.nx-node time');
  await expect(times.first()).toContainText('09:00:00'); // 01:00Z queued run-old
  const stamps = await times.evaluateAll((els) => els.map((e) => e.getAttribute('datetime')!));
  expect(stamps).toEqual([...stamps].sort());
  await expect(lane.getByText(/Following 3 of 3 runs/)).toBeVisible();
  await expect(lane.getByText(/Live: receiving updates/)).toBeVisible(); // run-active's stream is open
  const pause = lane.getByRole('button', { name: 'Pause auto-scroll' });
  await pause.click();
  await expect(lane.getByRole('button', { name: 'Resume auto-scroll' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const toggle = lane.getByRole('button', { name: 'Expand' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(lane.getByRole('button', { name: 'Collapse' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});

test('empty workspace shows true empties, not fabricated activity', async ({ page }) => {
  await open(page, { tasks: [], runs: [] });
  await expect(readout(page)).toHaveText('Idle');
  await expect(laneOf(page).locator('.nx-empty')).toContainText('No events recorded.');
  await expect(page.getByText('No active run.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Active runs:\s*0/ })).toBeVisible();
  await expect(page.getByText('None recorded')).toBeVisible();
});

test('agents are never shown as executing', async ({ page }) => {
  await open(page);
  await expect(page.getByText(/does not report which agent handles a run/)).toBeVisible();
});

// ------------------------------------------------------------ graphics paths
type FrameControl = {
  requested: number;
  cancelled: number;
  pending: () => number;
  step: (count?: number) => void;
};
type Win = Window & { __frames: FrameControl; __io: (visible: boolean) => void };

/**
 * Replaces requestAnimationFrame with a queue the test advances by hand, and lets the test
 * drive IntersectionObserver visibility. No assertion below depends on wall-clock timing.
 */
async function installManualFrames(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Win;
    const queue = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    let clock = 1000;
    const control: FrameControl = {
      requested: 0,
      cancelled: 0,
      pending: () => queue.size,
      step(count = 1) {
        for (let i = 0; i < count; i++) {
          const batch = [...queue.values()];
          queue.clear();
          clock += 16.7;
          for (const callback of batch) callback(clock);
        }
      },
    };
    w.__frames = control;
    window.requestAnimationFrame = (callback) => {
      control.requested++;
      queue.set(++nextId, callback);
      return nextId;
    };
    window.cancelAnimationFrame = (id) => {
      if (queue.delete(id)) control.cancelled++;
    };
    const Native = window.IntersectionObserver;
    const callbacks: IntersectionObserverCallback[] = [];
    window.IntersectionObserver = class extends Native {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        callbacks.push(callback);
      }
    };
    w.__io = (visible) =>
      callbacks.forEach((callback) =>
        callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
  });
}
const frames = <T>(page: Page, fn: (f: FrameControl) => T) =>
  page.evaluate(`(${fn.toString()})(window.__frames)`) as Promise<T>;

test('reduced motion renders a static, non-blank reactor and no animation loop', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installManualFrames(page);
  await open(page);
  await expect(page.locator('.reactor')).toHaveAttribute('data-reactor-mode', 'static');
  await frames(page, (f) => f.step(4)); // draws the single static frame, if any is scheduled
  const nonBlank = await page.locator('canvas.reactor-canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 20) lit++;
    return lit;
  });
  expect(nonBlank).toBeGreaterThan(500);
  // No loop: once drained, stepping again schedules nothing new.
  const before = await frames(page, (f) => f.requested);
  await frames(page, (f) => f.step(5));
  expect(await frames(page, (f) => f.pending())).toBe(0);
  expect(await frames(page, (f) => f.requested)).toBe(before);
});

test('graphics failure falls back to a static illustration with intact controls', async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  await open(page);
  await expect(page.locator('.reactor')).toHaveAttribute('data-reactor-mode', 'unavailable');
  await expect(page.locator('svg.reactor-fallback')).toBeVisible();
  await expect(page.getByText('Visualization unavailable.')).toBeVisible();
  await expect(readout(page)).toHaveText('Mock execution active');
  await page.getByRole('button', { name: 'Request stop' }).click();
  await expect(page.getByRole('button', { name: 'Stop requested' })).toBeVisible();
  await page.getByRole('button', { name: 'Create task' }).click();
  await expect(page).toHaveURL(/#tasks$/);
  await axe(page);
});

test.describe('renderer lifecycle (manual frame clock)', () => {
  const setHidden = (page: Page, hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

  test('keeps scheduling frames while visible', async ({ page }) => {
    await installManualFrames(page);
    await open(page);
    await expect.poll(() => frames(page, (f) => f.pending())).toBeGreaterThan(0);
    const before = await frames(page, (f) => f.requested);
    await frames(page, (f) => f.step(5));
    // every stepped frame re-armed the loop
    expect((await frames(page, (f) => f.requested)) - before).toBeGreaterThanOrEqual(5);
    expect(await frames(page, (f) => f.pending())).toBeGreaterThan(0);
  });

  test('suspends while the document is hidden and resumes when shown', async ({ page }) => {
    await installManualFrames(page);
    await open(page);
    await expect.poll(() => frames(page, (f) => f.pending())).toBeGreaterThan(0);
    await setHidden(page, true);
    await frames(page, (f) => f.step(3));
    expect(await frames(page, (f) => f.pending())).toBe(0);
    await setHidden(page, false);
    expect(await frames(page, (f) => f.pending())).toBeGreaterThan(0);
  });

  test('suspends while scrolled offscreen and resumes when visible again', async ({ page }) => {
    await installManualFrames(page);
    await open(page);
    await expect.poll(() => frames(page, (f) => f.pending())).toBeGreaterThan(0);
    await page.evaluate(() => (window as unknown as Win).__io(false));
    await frames(page, (f) => f.step(3));
    expect(await frames(page, (f) => f.pending())).toBe(0);
    await page.evaluate(() => (window as unknown as Win).__io(true));
    expect(await frames(page, (f) => f.pending())).toBeGreaterThan(0);
  });

  test('unmount cancels the pending frame, stops the loop and releases the canvas', async ({
    page,
  }) => {
    await installManualFrames(page);
    await open(page);
    await expect.poll(() => frames(page, (f) => f.pending())).toBeGreaterThan(0);
    await frames(page, (f) => f.step(2));
    const canvas = await page.locator('canvas.reactor-canvas').elementHandle();
    expect(await canvas!.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
    const cancelledBefore = await frames(page, (f) => f.cancelled);

    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.locator('canvas.reactor-canvas')).toHaveCount(0);

    // destroy() cancelled the frame that was waiting, and nothing re-armed it
    expect(await frames(page, (f) => f.cancelled)).toBeGreaterThan(cancelledBefore);
    await frames(page, (f) => f.step(3));
    const requested = await frames(page, (f) => f.requested);
    await frames(page, (f) => f.step(3));
    expect(await frames(page, (f) => f.requested)).toBe(requested);
    // backing store released
    expect(await canvas!.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([0, 0]);
  });
});

test('measured reactor cost at 1440x900 (reported, not asserted against a target)', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await page.waitForTimeout(1500); // let the entrance sequence finish
  const result = await page.evaluate(
    () =>
      new Promise<{ frames: number; avgMs: number; p95Ms: number; worstMs: number }>((resolve) => {
        const deltas: number[] = [];
        let last = performance.now();
        const start = last;
        const step = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (now - start < 4000) requestAnimationFrame(step);
          else {
            const sorted = [...deltas].sort((a, b) => a - b);
            resolve({
              frames: deltas.length,
              avgMs: deltas.reduce((s, d) => s + d, 0) / deltas.length,
              p95Ms: sorted[Math.floor(sorted.length * 0.95)]!,
              worstMs: sorted[sorted.length - 1]!,
            });
          }
        };
        requestAnimationFrame(step);
      }),
  );
  testInfo.annotations.push({ type: 'perf', description: JSON.stringify(result) });
  console.log('NEXUS_PERF', JSON.stringify(result));
  expect(result.frames).toBeGreaterThan(30); // the loop is alive; no frame-rate claim is made here
});

// ------------------------------------------------------- responsive and a11y
const viewports = [
  { name: '1920x1080', width: 1920, height: 1080 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '390x844', width: 390, height: 844 },
  { name: '360x740', width: 360, height: 740 },
  { name: '320x640', width: 320, height: 640 },
];

for (const vp of viewports) {
  test(`layout, overflow and axe at ${vp.name}`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await open(page);
    await page.waitForTimeout(1600); // entrance complete
    const metrics = await page.evaluate(() => {
      const doc = document.documentElement;
      const wide = [...document.querySelectorAll<HTMLElement>('.nexus *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            (r.right > innerWidth + 1 || r.left < -1) &&
            !el.closest('.nx-lane-list, .nx-rail, .reactor-grid')
          );
        })
        .map((el) => el.className.toString() || el.tagName);
      const reactor = document.querySelector('.reactor')!.getBoundingClientRect();
      return {
        scrollWidth: doc.scrollWidth,
        innerWidth,
        wide,
        reactorH: reactor.height,
        reactorW: reactor.width,
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(vp.width);
    expect(metrics.wide).toEqual([]);
    if (vp.width >= 1024) expect(metrics.reactorW).toBeGreaterThan(vp.width * 0.4);
    await expect(page.getByRole('button', { name: 'Create task' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /Review approval to start/ }).first(),
    ).toBeVisible();
    await axe(page);
    if (shotDir)
      await page.screenshot({ path: `${shotDir}/nexus-${vp.name}.png`, fullPage: vp.width < 1024 });
  });
}

test('keyboard: skip link, rail, and focus rings are reachable and visible', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(/#command-center$/);
  await page.getByRole('link', { name: 'Tasks' }).focus();
  const outline = await page
    .getByRole('link', { name: 'Tasks' })
    .evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe('solid');
});

test('sign out remains reachable from the cinematic shell', async ({ page }) => {
  const api = await open(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => api.requests.some((r) => r.path === '/api/v1/auth/logout')).toBe(true);
});

// ------------------------------------------------------------ mission lane (event-driven)
const laneOf = (page: Page) => page.getByRole('region', { name: 'Mission lane' });
const nodesOf = (page: Page, runId: string) => page.locator(`.nx-node[data-run="${runId}"]`);
const min = (n: number) => `2026-11-03T02:${String(n).padStart(2, '0')}:00.000Z`;

type SourceStats = { created: number; closed: number; open: number; maxOpen: number };
async function countEventSources(page: Page) {
  await page.addInitScript(() => {
    const stats = { created: 0, closed: 0, open: 0, maxOpen: 0 };
    (window as unknown as { __sse: typeof stats }).__sse = stats;
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      private done = false;
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        stats.created++;
        stats.open++;
        stats.maxOpen = Math.max(stats.maxOpen, stats.open);
      }
      override close() {
        if (!this.done) {
          this.done = true;
          stats.closed++;
          stats.open--;
        }
        super.close();
      }
    } as typeof EventSource;
  });
}
const sourceStats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sse: SourceStats }).__sse);

test('lane shows persisted events from the run event stream, in order, with their messages', async ({
  page,
}) => {
  const api = await open(page, {
    events: {
      'run-active': [
        runEvent('run-active', 1, 'run.queued', min(1), 'Queued for the mock runtime.'),
        runEvent('run-active', 2, 'run.started', min(2)),
        runEvent('run-active', 3, 'run.output', min(3), 'Reading notes'),
      ],
    },
  });
  const lane = laneOf(page);
  await expect(lane.getByText(/Live: receiving updates/)).toBeVisible();
  const labels = await nodesOf(page, 'run-active').locator('.nx-node-label').allTextContents();
  expect(labels).toEqual(['Queued', 'Started']); // output lines stay in the inspector
  await expect(nodesOf(page, 'run-active').first()).toContainText('Index the knowledge base');
  await expect(nodesOf(page, 'run-active').first()).toContainText('Queued for the mock runtime.');
  const stamps = await lane
    .locator('.nx-node time')
    .evaluateAll((els) => els.map((e) => e.getAttribute('datetime')!));
  expect(stamps.length).toBeGreaterThanOrEqual(5);
  expect(stamps).toEqual([...stamps].sort());
  expect(api.hub.requests.map((r) => r.runId).sort()).toEqual(['run-active', 'run-bad', 'run-old']);
  expect(api.requests.filter((r) => r.method !== 'GET')).toEqual([]); // reading never writes
});

test('events pushed after load appear live, once, in order', async ({ page }) => {
  const api = await open(page);
  await expect(nodesOf(page, 'run-active')).toHaveCount(2);
  api.hub.publish('run-active', runEvent('run-active', 3, 'run.stop_requested', min(6)));
  await expect(nodesOf(page, 'run-active')).toHaveCount(3);
  expect(await nodesOf(page, 'run-active').locator('.nx-node-label').allTextContents()).toEqual([
    'Queued',
    'Started',
    'Stop requested',
  ]);
});

test('reconnect resumes from the last event id, drops replays and keeps history', async ({
  page,
}) => {
  const api = await open(page);
  await expect(nodesOf(page, 'run-active')).toHaveCount(2);
  api.hub.publish('run-active', runEvent('run-active', 3, 'run.stop_requested', min(6)));
  await expect(nodesOf(page, 'run-active')).toHaveCount(3);

  api.hub.replayAll = true; // a lossy server that re-sends everything on reconnect
  api.hub.drop('run-active');
  await expect.poll(() => api.hub.connections('run-active')).toBe(1);
  const attempts = api.hub.requests.filter((r) => r.runId === 'run-active');
  expect(attempts[0]!.lastEventId).toBeUndefined();
  expect(attempts.at(-1)!.lastEventId).toBe('3'); // browser resumes from its cursor
  await expect(nodesOf(page, 'run-active')).toHaveCount(3); // replay produced no duplicates

  api.hub.publish('run-active', runEvent('run-active', 4, 'run.interrupted', min(7)));
  await expect(nodesOf(page, 'run-active')).toHaveCount(4);
});

test('a dropped connection is reported and the loaded history stays visible', async ({ page }) => {
  const api = await open(page);
  await expect(laneOf(page).getByText(/Live: receiving updates/)).toBeVisible();
  api.hub.failWith('run-active', 503);
  api.hub.drop('run-active');
  const lane = laneOf(page);
  await expect(lane.locator('[data-lane-status="reconnecting"]')).toBeVisible();
  await expect(lane.getByText(/Connection interrupted/)).toBeVisible();
  await expect(nodesOf(page, 'run-active')).toHaveCount(2); // history retained
  await expect(lane.getByText(/Live: receiving updates/)).toHaveCount(0); // not labelled live

  api.hub.failWith('run-active', null); // service returns: the lane recovers on its own
  await expect(lane.locator('[data-lane-status="live"]')).toBeVisible({ timeout: 15000 });
  await expect(nodesOf(page, 'run-active')).toHaveCount(2);
});

test('finished runs replay history but are not labelled live', async ({ page }) => {
  await open(page, {
    runs: [run('run-old', 'task-done', 'Audit access notes', 'completed', min(30), min(20))],
  });
  await expect(laneOf(page).locator('[data-lane-status="history"]')).toBeVisible();
  await expect(laneOf(page).getByText(/Live: receiving updates/)).toHaveCount(0);
  await expect(nodesOf(page, 'run-old')).toHaveCount(2);
});

test('follows at most four runs and closes every stream when the screen unmounts', async ({
  page,
}) => {
  await countEventSources(page);
  const many = Array.from({ length: 6 }, (_, i) =>
    run(`run-${i}`, `task-${i}`, `Mission ${i}`, 'running', min(10 + i), min(i)),
  );
  const api = await open(page, { runs: many });
  await expect(laneOf(page).getByText(/Following 4 of 6 runs/)).toBeVisible();
  await expect.poll(async () => (await sourceStats(page)).open).toBe(4);
  expect((await sourceStats(page)).maxOpen).toBe(4);
  expect([...new Set(api.hub.requests.map((r) => r.runId))].sort()).toEqual([
    'run-2',
    'run-3',
    'run-4',
    'run-5',
  ]);
  // an ordinary rerender (selecting a run) must not open duplicate streams
  const created = (await sourceStats(page)).created;
  await page.locator('.nx-node').first().click();
  await page.locator('.nx-node').first().click();
  expect((await sourceStats(page)).created).toBe(created);

  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(laneOf(page)).toHaveCount(0);
  await expect.poll(async () => (await sourceStats(page)).open).toBe(0);
  const after = await sourceStats(page);
  expect(after.closed).toBe(after.created);
  for (const id of ['run-2', 'run-3', 'run-4', 'run-5'])
    await expect.poll(() => api.hub.connections(id)).toBe(0); // the server saw them close
});

test('a terminal event closes that stream and refreshes the stale run record once', async ({
  page,
}) => {
  await countEventSources(page);
  const api = await open(page);
  await expect(laneOf(page).getByText(/Live: receiving updates/)).toBeVisible();
  const listFetches = () =>
    api.requests.filter((r) => r.path === '/api/v1/runs' && r.method === 'GET').length;
  const before = listFetches();
  api.hub.publish('run-active', runEvent('run-active', 3, 'run.completed', min(8)));
  await expect(nodesOf(page, 'run-active')).toHaveCount(3);
  await expect.poll(listFetches).toBe(before + 1); // record said "running": refetched, once
  await page.waitForTimeout(300);
  expect(listFetches()).toBe(before + 1);
  await expect.poll(() => api.hub.connections('run-active')).toBe(0);
});

// ------------------------------------------------------------ stale reactor markers
test('a failed runs refresh removes reactor markers instead of showing stale activity', async ({
  page,
}) => {
  const api = await open(page);
  const reactor = page.locator('.reactor');
  await expect(readout(page)).toHaveText('Mock execution active');
  const markers = (await reactor.getAttribute('data-markers'))!.split(',').sort();
  expect(markers).toEqual(['run-active:running', 'run-bad:failed', 'run-old:completed']);

  api.setRunFailures(1);
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(readout(page)).toHaveText('System state unavailable');
  await expect(reactor).toHaveAttribute('data-reactor-state', 'data-unavailable');
  await expect(reactor).toHaveAttribute('data-markers', ''); // nothing implies current activity
  await expect(page.getByRole('button', { name: /^Active runs:\s*Unavailable/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Active runs:\s*0/ })).toHaveCount(0);
  // loaded event history is retained, but the lane says it is disconnected
  await expect(laneOf(page).locator('[data-lane-status="disconnected"]')).toBeVisible();
  await expect(nodesOf(page, 'run-active').first()).toBeVisible();

  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(readout(page)).toHaveText('Mock execution active');
  expect((await reactor.getAttribute('data-markers'))!.split(',').sort()).toEqual(markers);
  await expect(laneOf(page).locator('[data-lane-status="live"]')).toBeVisible();
});

// ------------------------------------------------------------ transport drops (controlled EventSource)
const alpha = run('run-a', 't1', 'Alpha mission', 'running', min(5), min(1));
const bravo = run('run-b', 't2', 'Bravo mission', 'running', min(6), min(2));
const ended = run('run-d', 't3', 'Done mission', 'completed', min(7), min(3));
async function openFake(
  page: Page,
  runs = [alpha, bravo],
  extra: NexusApiOptions = {},
  retryMs = 20,
) {
  await installFakeEventSource(
    page,
    Object.fromEntries(runs.map((r) => [r.id, defaultRunEvents(r)])),
    retryMs,
  );
  return open(page, { runs, ...extra });
}
const statusText = (page: Page) => laneOf(page).locator('.nx-lane-status');
const eventIds = (page: Page, runId: string) =>
  nodesOf(page, runId).evaluateAll((els) => els.map((e) => e.getAttribute('data-event-id')!));
const listFetches = (api: Awaited<ReturnType<typeof open>>) =>
  api.requests.filter((r) => r.path === '/api/v1/runs' && r.method === 'GET').length;
const LIVE_2 = 'Live: receiving updates for all 2 unfinished runs.';

test('two live streams are fully live; a normal terminal end is not a failure', async ({
  page,
}) => {
  await openFake(page);
  await expect(statusText(page)).toHaveText(LIVE_2);
  await expect(laneOf(page).locator('[data-lane-status="live"]')).toBeVisible();
});

test('one active and one finished run: live, and the finished stream ended cleanly', async ({
  page,
}) => {
  await openFake(page, [alpha, ended]);
  await expect(statusText(page)).toHaveText('Live: receiving updates for the unfinished run.');
  await expect(nodesOf(page, 'run-d')).toHaveCount(2);
  await expect.poll(async () => (await fake.stats(page)).open).toBe(1); // only alpha stays open
});

test('a transport drop reports partial connection, keeps history, and replays what was missed once', async ({
  page,
}) => {
  const api = await openFake(page, [alpha, bravo], {}, 400); // slow retries: outage is short
  await expect(statusText(page)).toHaveText(LIVE_2);
  const fetchesBefore = listFetches(api);
  const baseInstances = (await fake.stats(page)).instances['run-a']!;

  await fake.setDown(page, 'run-a', true);
  await fake.drop(page, 'run-a'); // native stream falls into CONNECTING and keeps retrying
  await expect(statusText(page)).toHaveText(
    'Partially connected: 1 of 2 unfinished runs live, 1 reconnecting. Loaded history is kept.',
  );
  await expect(nodesOf(page, 'run-a')).toHaveCount(2); // history preserved during the outage
  await fake.publish(page, 'run-b', runEvent('run-b', 3, 'run.stop_requested', min(9)));
  await expect(nodesOf(page, 'run-b')).toHaveCount(3); // the healthy stream is unaffected

  // events persisted while run-a was unreachable
  await fake.publish(page, 'run-a', runEvent('run-a', 3, 'run.stop_requested', min(8)));
  await fake.setDown(page, 'run-a', false);
  await expect(statusText(page)).toHaveText(LIVE_2);
  const ids = await eventIds(page, 'run-a');
  expect(ids).toEqual(['run-a:1', 'run-a:2', 'run-a:3']); // replayed, no duplicates
  const stats = await fake.stats(page);
  expect(stats.reconnectIds['run-a']!.at(-1)).toBe('2'); // browser resumed from its cursor
  expect(stats.instances['run-a']).toBe(baseInstances); // same stream, not a new subscription
  expect(listFetches(api)).toBe(fetchesBefore); // a drop alone does not trigger a session check
});

test('repeated native failures exhaust a finite budget, close the stream and stop retrying', async ({
  page,
}) => {
  const api = await openFake(page);
  await expect(statusText(page)).toHaveText(LIVE_2);
  const fetchesBefore = listFetches(api);
  const base = (await fake.stats(page)).instances['run-a']!;
  await fake.setDown(page, 'run-a', true);
  await fake.drop(page, 'run-a');
  await expect(statusText(page)).toHaveText(
    'Partially connected: 1 of 2 unfinished runs live, 1 stopped after retries. Loaded history is kept.',
  );
  const after = await fake.stats(page);
  expect(after.errors['run-a']).toBe(5); // MAX_FAILURES + 1: the fifth failure exhausts the budget
  expect(after.instances['run-a']).toBe(base); // nothing was re-created
  expect(after.open).toBe(1); // run-a was explicitly closed; only run-b remains open
  await expect(nodesOf(page, 'run-a')).toHaveCount(2); // history kept

  // the "browser" would retry every 20ms; wait many intervals and prove it did not
  await page.waitForTimeout(400);
  const later = await fake.stats(page);
  expect(later.errors['run-a']).toBe(5);
  expect(later.instances['run-a']).toBe(base);
  // exhaustion is when a real request establishes whether the session is still valid
  await expect.poll(() => listFetches(api)).toBe(fetchesBefore + 1);
  await page.waitForTimeout(200);
  expect(listFetches(api)).toBe(fetchesBefore + 1);

  // Recovery from partial connectivity needs an explicit user retry
  await fake.publish(page, 'run-a', runEvent('run-a', 3, 'run.stop_requested', min(8)));
  await fake.setDown(page, 'run-a', false);
  await page.waitForTimeout(150);
  expect((await fake.stats(page)).instances['run-a']).toBe(base); // not restarted by itself
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(statusText(page)).toHaveText(LIVE_2);
  expect((await fake.stats(page)).instances['run-a']).toBe(base + 1); // exactly one new stream
  // the new stream replays persisted history from the start; duplicates are dropped
  expect(await eventIds(page, 'run-a')).toEqual(['run-a:1', 'run-a:2', 'run-a:3']);
  expect(await eventIds(page, 'run-b')).toEqual(['run-b:1', 'run-b:2']);
});

test('every stream exhausted: retry limit reported for all runs, history kept', async ({
  page,
}) => {
  await openFake(page);
  await expect(statusText(page)).toHaveText(LIVE_2);
  for (const id of ['run-a', 'run-b']) {
    await fake.setDown(page, id, true);
    await fake.drop(page, id);
  }
  await expect(statusText(page)).toHaveText(
    'Retry limit reached for 2 runs. Live updates stopped; loaded history is kept. Use Refresh to retry.',
  );
  await expect(laneOf(page).locator('[data-lane-status="exhausted"]')).toBeVisible();
  await expect(laneOf(page).getByText(/Live: receiving updates/)).toHaveCount(0);
  await expect(page.locator('.nx-node')).toHaveCount(4);
  expect((await fake.stats(page)).open).toBe(0);
});

test('a stream stuck connecting (no further errors) is closed after the failure window', async ({
  page,
}) => {
  await page.clock.install();
  await openFake(page, [alpha]);
  await page.clock.runFor(100);
  await expect(statusText(page)).toHaveText('Live: receiving updates for the unfinished run.');
  await fake.setHang(page, 'run-a', true); // reconnect attempts never answer
  await fake.setDown(page, 'run-a', true);
  await fake.drop(page, 'run-a'); // one error, then silence
  await page.clock.runFor(100);
  await expect(statusText(page)).toHaveText(
    'Connection interrupted. Reconnecting; loaded history is kept.',
  );
  await page.clock.runFor(31_000);
  await expect(laneOf(page).locator('[data-lane-status="exhausted"]')).toBeVisible();
  expect((await fake.stats(page)).open).toBe(0);
});

test('unmounting while reconnecting closes the stream and leaves no timers behind', async ({
  page,
}) => {
  await openFake(page);
  await expect(statusText(page)).toHaveText(LIVE_2);
  await fake.setDown(page, 'run-a', true);
  await fake.drop(page, 'run-a');
  await expect(laneOf(page).locator('[data-lane-status="partial"]')).toBeVisible();
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(laneOf(page)).toHaveCount(0);
  await expect.poll(async () => (await fake.stats(page)).open).toBe(0);
  const settled = await fake.stats(page);
  await page.waitForTimeout(300);
  const later = await fake.stats(page);
  expect(later.errors).toEqual(settled.errors); // no retries after unmount
  expect(later.created).toBe(settled.created); // no new subscriptions
});

test('an expired session is only acted on once a real request establishes it', async ({ page }) => {
  const api = await openFake(page, [alpha], {}, 400);
  await expect(statusText(page)).toHaveText('Live: receiving updates for the unfinished run.');
  await fake.setDown(page, 'run-a', true);
  await fake.drop(page, 'run-a');
  await expect(laneOf(page).locator('[data-lane-status="reconnecting"]')).toBeVisible();
  // the session expires, but a failing stream says nothing about why: no 401 is inferred
  api.setRunsUnauthorized(true);
  await page.waitForTimeout(300);
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toHaveCount(0);
  // only after the budget is exhausted does the app make a real request, which reports 401
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible({
    timeout: 10_000,
  });
});

test('hidden tabs hold no stream; showing the tab replays missed events without duplicates', async ({
  page,
}) => {
  await openFake(page);
  await expect(statusText(page)).toHaveText(LIVE_2);
  const base = (await fake.stats(page)).instances['run-a']!;
  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await setHidden(true);
  await expect(statusText(page)).toHaveText(
    'Paused while this tab is hidden. Loaded history is kept; updates resume when you return.',
  );
  expect((await fake.stats(page)).open).toBe(0);
  await expect(nodesOf(page, 'run-a')).toHaveCount(2); // history kept
  await fake.publish(page, 'run-a', runEvent('run-a', 3, 'run.stop_requested', min(8)));
  await setHidden(false);
  await expect(statusText(page)).toHaveText(LIVE_2);
  expect(await eventIds(page, 'run-a')).toEqual(['run-a:1', 'run-a:2', 'run-a:3']);
  expect((await fake.stats(page)).instances['run-a']).toBe(base + 1);
});

test('an exhausted stream is not restarted when the followed set changes; only Refresh restarts it', async ({
  page,
}) => {
  const charlie = run('run-c', 't4', 'Charlie mission', 'running', min(10), min(4));
  await installFakeEventSource(
    page,
    Object.fromEntries([alpha, bravo, charlie].map((r) => [r.id, defaultRunEvents(r)])),
  );
  const api = await open(page, { runs: [alpha, bravo] });
  await expect(statusText(page)).toHaveText(LIVE_2);
  const base = (await fake.stats(page)).instances['run-a']!;
  api.setRuns([alpha, bravo, charlie]); // the exhaustion-triggered refresh now returns a new run
  await fake.setDown(page, 'run-a', true);
  await fake.drop(page, 'run-a');
  await expect(statusText(page)).toHaveText(
    'Partially connected: 2 of 3 unfinished runs live, 1 stopped after retries. Loaded history is kept.',
  );
  await expect(nodesOf(page, 'run-c')).toHaveCount(2); // the followed set did change
  await page.waitForTimeout(300);
  const stats = await fake.stats(page);
  expect(stats.instances['run-a']).toBe(base); // run-a was not silently recreated
  expect(stats.errors['run-a']).toBe(5);
});

// ------------------------------------------------------------ retry budget lifecycle (frozen clock)
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

/**
 * Opens the screen under a controlled clock that is then frozen, so every timer in the app and
 * in the fake EventSource only advances through `tick`. Failures are counted exactly.
 */
async function openFrozen(page: Page, runs: Run[], histories: Run[] = runs) {
  await page.clock.install({ time: new Date('2026-11-03T03:00:00Z') });
  await installFakeEventSource(
    page,
    Object.fromEntries(histories.map((r) => [r.id, defaultRunEvents(r)])),
  );
  const api = await open(page, { runs });
  await page.clock.pauseAt(new Date('2026-11-03T03:01:00Z'));
  return api;
}
const tick = (page: Page, ms: number) => page.clock.runFor(ms);
const errorsOf = async (page: Page, id: string) => (await fake.stats(page)).errors[id] ?? 0;
const instancesOf = async (page: Page, id: string) => (await fake.stats(page)).instances[id] ?? 0;
const INTERRUPTED = 'Connection interrupted. Reconnecting; loaded history is kept.';
const EXHAUSTED_1 =
  'Retry limit reached for 1 run. Live updates stopped; loaded history is kept. Use Refresh to retry.';
const LIVE_1 = 'Live: receiving updates for the unfinished run.';

/** Starts an outage on one run and spends `n` failures (the drop is failure 1). */
async function fail(page: Page, id: string, n: number) {
  await fake.setDown(page, id, true);
  await fake.drop(page, id);
  for (let i = 1; i < n; i++) await tick(page, 20);
}
/** Brings the server back and lets the browser's own retry reconnect. */
async function recover(page: Page, id: string) {
  await fake.setDown(page, id, false);
  await tick(page, 20);
}

test.describe('retry budget survives transport replacement', () => {
  test('three failures, hide, show, two more failures: exhausts on the fifth cumulative failure', async ({
    page,
  }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 3);
    expect(await errorsOf(page, 'run-a')).toBe(3);
    await expect(statusText(page)).toHaveText(INTERRUPTED);

    await setHidden(page, true);
    await expect(laneOf(page).locator('[data-lane-status="paused"]')).toBeVisible();
    expect((await fake.stats(page)).open).toBe(0); // no transport while hidden
    await setHidden(page, false);
    await expect(laneOf(page).locator('[data-lane-status="paused"]')).toHaveCount(0);

    await tick(page, 1); // the replacement transport's first attempt: cumulative failure 4
    expect(await errorsOf(page, 'run-a')).toBe(4);
    await expect(statusText(page)).toHaveText(INTERRUPTED);
    await tick(page, 20); // cumulative failure 5
    expect(await errorsOf(page, 'run-a')).toBe(5);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test('an exhausted stream stays exhausted through hide and show', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 5);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    const before = await instancesOf(page, 'run-a');
    await setHidden(page, true);
    await setHidden(page, false);
    await tick(page, 200);
    expect(await instancesOf(page, 'run-a')).toBe(before); // no new connection
    expect(await errorsOf(page, 'run-a')).toBe(5);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    // only an explicit Refresh restarts it
    await fake.setDown(page, 'run-a', false);
    await page.getByRole('button', { name: 'Refresh data' }).dispatchEvent('click');
    await tick(page, 20);
    await expect(statusText(page)).toHaveText(LIVE_1);
    expect(await instancesOf(page, 'run-a')).toBe(before + 1);
  });

  test('exact fifth-failure boundary', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 4);
    expect(await errorsOf(page, 'run-a')).toBe(4);
    await expect(statusText(page)).toHaveText(INTERRUPTED); // four failures: still trying
    await tick(page, 20);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1); // the fifth ends it
  });

  test('the disconnection deadline: just before, exactly at, and after 30 s', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fake.setHang(page, 'run-a', true); // later attempts never answer: one error, then silence
    await fail(page, 'run-a', 1);
    await expect(statusText(page)).toHaveText(INTERRUPTED);
    await tick(page, 29_999);
    await expect(statusText(page)).toHaveText(INTERRUPTED); // just before
    await tick(page, 1);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1); // exactly at the deadline
    expect((await fake.stats(page)).open).toBe(0);
  });

  test('past the deadline in one step is exhausted', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fake.setHang(page, 'run-a', true);
    await fail(page, 'run-a', 1);
    await tick(page, 30_001);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test('time in a hidden tab is not counted: the deadline resumes with what was left', async ({
    page,
  }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fake.setHang(page, 'run-a', true);
    await fail(page, 'run-a', 1);
    await tick(page, 10_000); // 10 s of the 30 s used
    await setHidden(page, true);
    await expect(laneOf(page).locator('[data-lane-status="paused"]')).toBeVisible();
    await tick(page, 600_000); // ten minutes hidden
    await setHidden(page, false);
    await expect(statusText(page)).toHaveText(INTERRUPTED); // not restarted at 30 s, not expired
    await tick(page, 19_999);
    await expect(statusText(page)).toHaveText(INTERRUPTED);
    await tick(page, 1); // the remaining 20 s, exactly
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test.describe('cumulative disconnected time', () => {
    // Fast-forwarding a minute of fake time is slow in a real browser; the clock is exact.
    test.describe.configure({ timeout: 120_000 });
    /** First failure, then silence: the disconnected interval runs on the clock alone. */
    const stall = async (page: Page, id = 'run-a') => {
      await fake.setHang(page, id, true);
      await fake.setDown(page, id, true);
      await fake.drop(page, id);
    };
    /** The server answers the stuck attempt: a connection opens at the current clock time. */
    const reopen = async (page: Page, id = 'run-a') => {
      await fake.setDown(page, id, false);
      await fake.setHang(page, id, false);
      await expect(statusText(page)).toHaveText(LIVE_1);
    };
    /** Transport drops again: an error, then silence. */
    const redrop = async (page: Page, id = 'run-a') => {
      await fake.setHang(page, id, true);
      await fake.setDown(page, id, true);
      await fake.drop(page, id);
    };

    /**
     * Moves only the wall clock. The monotonic clock (performance.now) must not move, which the
     * helper verifies so these tests cannot pass because the two clocks were coupled.
     */
    const HOURS = 3_600_000;
    const jumpWallClock = async (page: Page, deltaMs: number) => {
      const before = await page.evaluate(() => ({ wall: Date.now(), mono: performance.now() }));
      await page.clock.setSystemTime(new Date(before.wall + deltaMs));
      const after = await page.evaluate(() => ({ wall: Date.now(), mono: performance.now() }));
      expect(after.wall - before.wall).toBeGreaterThanOrEqual(deltaMs);
      expect(after.wall - before.wall).toBeLessThan(deltaMs + 1000);
      expect(Math.abs(after.mono - before.mono)).toBeLessThan(1000); // only real elapsed time
    };

    test.describe('wall-clock adjustments do not change the allowance', () => {
      test('a forward wall-clock jump charges nothing extra', async ({ page }) => {
        await openFrozen(page, [alpha]);
        await expect(statusText(page)).toHaveText(LIVE_1);
        await stall(page);
        await tick(page, 10_000);
        await jumpWallClock(page, 5 * HOURS);
        await reopen(page); // closes the interval: 10 s, not 5 h
        await tick(page, 1_000);
        await redrop(page);
        await tick(page, 19_999); // 10 s + 19.999 s
        await expect(statusText(page)).toHaveText(INTERRUPTED);
        await tick(page, 1);
        await expect(statusText(page)).toHaveText(EXHAUSTED_1);
      });

      test('a backward wall-clock jump neither goes negative nor extends the allowance', async ({
        page,
      }) => {
        await openFrozen(page, [alpha]);
        await expect(statusText(page)).toHaveText(LIVE_1);
        await stall(page);
        await tick(page, 10_000);
        await jumpWallClock(page, -5 * HOURS);
        await reopen(page);
        await tick(page, 1_000);
        await redrop(page);
        await tick(page, 19_999); // exactly 10 s + 19.999 s: not a millisecond of extension
        await expect(statusText(page)).toHaveText(INTERRUPTED);
        await tick(page, 1);
        await expect(statusText(page)).toHaveText(EXHAUSTED_1);
      });

      test('short reconnect (20 s, 5 s open, 9 s, 1 s) holds while the wall clock moves', async ({
        page,
      }) => {
        await openFrozen(page, [alpha]);
        await expect(statusText(page)).toHaveText(LIVE_1);
        await stall(page);
        await tick(page, 20_000);
        await reopen(page);
        await tick(page, 2_500);
        await jumpWallClock(page, 4 * HOURS); // during the connected interval
        await tick(page, 2_500);
        await jumpWallClock(page, -9 * HOURS);
        await expect(statusText(page)).toHaveText(LIVE_1);
        await redrop(page);
        await tick(page, 9_000);
        await expect(statusText(page)).toHaveText(INTERRUPTED); // 29 s cumulative: eligible
        await jumpWallClock(page, 2 * HOURS); // and during the disconnected interval
        await tick(page, 1_000);
        await expect(statusText(page)).toHaveText(EXHAUSTED_1);
      });

      test('9,999 ms open is not stable even if the wall clock jumps forward', async ({ page }) => {
        await openFrozen(page, [alpha]);
        await expect(statusText(page)).toHaveText(LIVE_1);
        await stall(page);
        await tick(page, 20_000);
        await reopen(page);
        await tick(page, 9_999);
        await jumpWallClock(page, 5 * HOURS);
        await redrop(page);
        await tick(page, 9_999);
        await expect(statusText(page)).toHaveText(INTERRUPTED); // budget not reset: 10 s left
        await tick(page, 1);
        await expect(statusText(page)).toHaveText(EXHAUSTED_1);
      });

      test('10,000 ms open is stable even if the wall clock jumps backward', async ({ page }) => {
        await openFrozen(page, [alpha]);
        await expect(statusText(page)).toHaveText(LIVE_1);
        await stall(page);
        await tick(page, 20_000);
        await reopen(page);
        await tick(page, 10_000);
        await jumpWallClock(page, -5 * HOURS);
        await redrop(page);
        await tick(page, 29_999); // a fresh allowance
        await expect(statusText(page)).toHaveText(INTERRUPTED);
        await tick(page, 1);
        await expect(statusText(page)).toHaveText(EXHAUSTED_1);
      });
    });

    test('a short successful reconnect does not charge connected time to the allowance', async ({
      page,
    }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page); // failure 1: disconnected interval starts
      await tick(page, 20_000); // 20 s disconnected
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await reopen(page);
      await tick(page, 5_000); // connected for 5 s: below the 10 s stable threshold
      await expect(statusText(page)).toHaveText(LIVE_1); // not exhausted while connected
      await redrop(page); // failure 2
      expect(await errorsOf(page, 'run-a')).toBe(2);
      await tick(page, 8_999); // 20 s + 8.999 s = 28.999 s cumulative
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1); // 29.000 s
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 999); // 29.999 s
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1); // 30.000 s cumulative
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });

    test('exact boundary across intervals: 29,999 ms is alive, 30,000 ms is exhausted', async ({
      page,
    }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page);
      await tick(page, 15_000);
      await reopen(page);
      await tick(page, 3_000);
      await redrop(page);
      await tick(page, 14_999); // 15,000 + 14,999
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1);
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });

    test('rapid transitions at one instant add no time and do not double-count', async ({
      page,
    }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page);
      await tick(page, 10_000);
      for (let i = 0; i < 3; i++) {
        await reopen(page); // open and drop again with no time passing: 0 ms charged
        await redrop(page);
      }
      expect(await errorsOf(page, 'run-a')).toBe(4); // four failures: one more is still allowed
      await tick(page, 19_999); // 10,000 + 19,999
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1);
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });

    test('several short openings exclude connected time and leave the failure count to count', async ({
      page,
    }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page); // failure 1
      for (let cycle = 2; cycle <= 4; cycle++) {
        await tick(page, 9_000); // 9 s down
        await reopen(page);
        await tick(page, 3_000); // 3 s up: not stable, no progress
        await redrop(page); // failure `cycle`
        expect(await errorsOf(page, 'run-a')).toBe(cycle);
      }
      // 27 s disconnected after three completed outages; wall clock is already 36 s.
      await tick(page, 2_999);
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1); // the 4th failure is not the limit: cumulative time is
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
      expect(await errorsOf(page, 'run-a')).toBe(4);
    });

    test('short openings do not reset the failure count: the fifth failure still exhausts first', async ({
      page,
    }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page);
      for (let cycle = 2; cycle <= 4; cycle++) {
        await tick(page, 1_000);
        await reopen(page);
        await tick(page, 5_000);
        await redrop(page);
      }
      await tick(page, 1_000);
      await reopen(page);
      await tick(page, 5_000);
      await fake.drop(page, 'run-a'); // the fifth failure, with only 4 s disconnected
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
      expect(await errorsOf(page, 'run-a')).toBe(5);
    });

    test('ten continuous seconds open reset the allowance; 9,999 ms do not', async ({ page }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page);
      await tick(page, 20_000);
      await reopen(page);
      await tick(page, 10_000); // stable: the budget, including the 20 s, is cleared
      await redrop(page);
      await tick(page, 29_999); // a fresh 30 s allowance
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1);
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });

    test('9,999 ms open is not stable: the spent allowance carries over', async ({ page }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page);
      await tick(page, 20_000);
      await reopen(page);
      await tick(page, 9_999);
      await redrop(page);
      await tick(page, 9_999); // 20,000 + 9,999
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1);
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });

    test('a new validated event clears the spent allowance', async ({ page }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page);
      await tick(page, 25_000);
      await reopen(page);
      await fake.publish(page, 'run-a', runEvent('run-a', 3, 'run.stop_requested', min(8)));
      await expect(nodesOf(page, 'run-a')).toHaveCount(3);
      await redrop(page);
      await tick(page, 29_999);
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1);
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });

    test('the hidden-tab pause keeps the cumulative total across a short opening', async ({
      page,
    }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await stall(page);
      await tick(page, 10_000);
      await reopen(page);
      await tick(page, 4_000);
      await redrop(page);
      await tick(page, 10_000); // 20 s cumulative
      await setHidden(page, true);
      await tick(page, 600_000);
      await setHidden(page, false);
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await fake.setHang(page, 'run-a', true); // the resumed transport also stays silent
      await tick(page, 9_999);
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1);
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });

    test('CLOSED retries use the remaining cumulative allowance', async ({ page }) => {
      await openFrozen(page, [alpha]);
      await expect(statusText(page)).toHaveText(LIVE_1);
      await fake.setHardFail(page, 'run-a', true);
      await fake.setDown(page, 'run-a', true);
      await fake.drop(page, 'run-a'); // failure 1, CLOSED: app retry in 1 s
      await tick(page, 1_000); // transport re-created (its attempt is one tick away)
      await fake.setHardFail(page, 'run-a', false);
      await fake.setDown(page, 'run-a', false);
      await tick(page, 1); // opens: 1,001 ms disconnected
      await expect(statusText(page)).toHaveText(LIVE_1);
      await tick(page, 5_000);
      await fake.setHardFail(page, 'run-a', true);
      await fake.setDown(page, 'run-a', true);
      await fake.drop(page, 'run-a'); // failure 2, CLOSED: backoff 2 s
      await fake.setHardFail(page, 'run-a', false);
      await fake.setHang(page, 'run-a', true); // the re-created transport stays silent
      await tick(page, 28_998); // 1,001 + 28,998 = 29,999
      await expect(statusText(page)).toHaveText(INTERRUPTED);
      await tick(page, 1);
      await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    });
  });

  test('app-managed CLOSED retries back off 1/2/4/8 s and then stop', async ({ page }) => {
    test.setTimeout(60_000);
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    const base = await instancesOf(page, 'run-a');
    await fake.setHardFail(page, 'run-a', true); // refused: the browser gives up (CLOSED)
    await fail(page, 'run-a', 1);
    const at = async (ms: number, instances: number, errors: number) => {
      await tick(page, ms);
      expect(await instancesOf(page, 'run-a')).toBe(base + instances);
      expect(await errorsOf(page, 'run-a')).toBe(errors);
    };
    // A re-created transport answers one millisecond after it is created (error k+1), and the
    // backoff for failure k is 1000 * 2^(k-1) ms measured from that failure.
    await at(999, 0, 1);
    await at(1, 1, 1); // backoff 1 s: transport re-created
    await at(1, 1, 2); // and it fails: second failure
    await at(1999, 1, 2); // 2 s backoff, not yet
    await at(1, 2, 2); // re-created
    await at(1, 2, 3);
    await at(3999, 2, 3); // 4 s backoff
    await at(1, 3, 3);
    await at(1, 3, 4);
    await at(7999, 3, 4); // 8 s backoff
    await at(1, 4, 4);
    await at(1, 4, 5); // the fifth failure
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
    await at(10_000, 4, 5); // nothing is retried afterwards (longer than the largest backoff)
  });

  test('unmounting with a retry pending cancels it', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fake.setHardFail(page, 'run-a', true);
    await fail(page, 'run-a', 1); // app retry timer (1 s) now pending
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(laneOf(page)).toHaveCount(0);
    const settled = await fake.stats(page);
    await tick(page, 120_000);
    const later = await fake.stats(page);
    expect(later.created).toBe(settled.created); // no EventSource appeared after unmount
    expect(later.open).toBe(0);
    expect(later.errors).toEqual(settled.errors);
  });

  test('a terminal event cancels the failure deadline', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 1);
    await recover(page, 'run-a');
    await fake.publish(page, 'run-a', runEvent('run-a', 3, 'run.completed', min(9)));
    await tick(page, 35_000); // past the 30 s window; a heavier fast-forward starves the renderer
    await expect(laneOf(page).locator('[data-lane-status="exhausted"]')).toHaveCount(0);
    expect(await errorsOf(page, 'run-a')).toBe(1);
  });
});

test.describe('what resets the retry budget', () => {
  test('a new validated event resets it', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 3);
    await recover(page, 'run-a');
    await fake.publish(page, 'run-a', runEvent('run-a', 3, 'run.stop_requested', min(8)));
    await expect(nodesOf(page, 'run-a')).toHaveCount(3);
    await fail(page, 'run-a', 4); // a fresh budget: four more failures are survivable
    await expect(statusText(page)).toHaveText(INTERRUPTED);
    await tick(page, 20);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test('a duplicate replay is not progress', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 3);
    await recover(page, 'run-a');
    await fake.publish(page, 'run-a', runEvent('run-a', 2, 'run.started', min(5))); // already seen
    await expect(nodesOf(page, 'run-a')).toHaveCount(2);
    await fail(page, 'run-a', 2); // cumulative: 3 + 2
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test('ten continuous seconds open resets it', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 3);
    await recover(page, 'run-a');
    await tick(page, 10_000);
    await fail(page, 'run-a', 4);
    await expect(statusText(page)).toHaveText(INTERRUPTED);
    await tick(page, 20);
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test('a connection that flaps before ten seconds does not reset it', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    await fail(page, 'run-a', 3);
    await recover(page, 'run-a');
    await tick(page, 9_999); // one millisecond short of stable
    await fail(page, 'run-a', 2); // cumulative: 3 + 2
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test('repeated open/close cycles without progress eventually exhaust', async ({ page }) => {
    await openFrozen(page, [alpha]);
    await expect(statusText(page)).toHaveText(LIVE_1);
    for (let i = 0; i < 4; i++) {
      await fake.drop(page, 'run-a'); // the server accepts every reconnect, then drops again
      await tick(page, 20);
      await expect(statusText(page)).toHaveText(LIVE_1);
    }
    await fake.drop(page, 'run-a'); // the fifth drop
    await expect(statusText(page)).toHaveText(EXHAUSTED_1);
  });

  test('budgets are independent per run', async ({ page }) => {
    await openFrozen(page, [alpha, bravo]);
    await expect(statusText(page)).toHaveText(LIVE_2);
    for (const id of ['run-a', 'run-b']) await fake.setDown(page, id, true);
    await fake.drop(page, 'run-a');
    await fake.drop(page, 'run-b');
    await tick(page, 40); // both have failed three times
    await fake.setDown(page, 'run-b', false);
    await tick(page, 20); // run-b recovers; run-a fails a fourth time
    await tick(page, 20); // run-a's fifth
    await expect(statusText(page)).toHaveText(
      'Partially connected: 1 of 2 unfinished runs live, 1 stopped after retries. Loaded history is kept.',
    );
    expect(await errorsOf(page, 'run-a')).toBe(5);
    expect(await errorsOf(page, 'run-b')).toBe(3); // run-a's failures were not charged to run-b
    await fake.setDown(page, 'run-b', true);
    await fake.drop(page, 'run-b'); // run-b's own fourth failure
    await tick(page, 20); // its fifth
    await expect(statusText(page)).toHaveText(
      'Retry limit reached for 2 runs. Live updates stopped; loaded history is kept. Use Refresh to retry.',
    );
  });
});

test.describe('retry state outlives followed-set eviction', () => {
  const dayRun = (id: string, updated: number) =>
    run(id, `t-${id}`, `Mission ${id}`, 'running', min(updated), min(1));
  const a = dayRun('run-a', 2); // oldest: the first to be evicted
  const b = dayRun('run-b', 3);
  const c = dayRun('run-c', 4);
  const d = dayRun('run-d', 5);
  const e = dayRun('run-e', 30); // newest: displaces run-a once present

  test('an exhausted run is not reconnected when it is evicted and later returns', async ({
    page,
  }) => {
    const api = await openFrozen(page, [a, b, c, d], [a, b, c, d, e]);
    await expect(laneOf(page).getByText(/Following 4 of 4 runs/)).toBeVisible();
    api.setRuns([a, b, c, d, e]); // the refresh after exhaustion will return a fifth run
    await fail(page, 'run-a', 5);
    // genuinely evicted: five runs exist, only four are followed, and run-a is not one of them
    await expect(laneOf(page).getByText(/Following 4 of 5 runs/)).toBeVisible();
    await expect(nodesOf(page, 'run-a')).toHaveCount(0);
    await tick(page, 5); // run-e's new transport answers
    await expect(nodesOf(page, 'run-e')).toHaveCount(2);
    const instances = await instancesOf(page, 'run-a');

    api.setRuns([a, b, c, d]); // run-e is gone; run-a is eligible again
    await fake.publish(page, 'run-d', runEvent('run-d', 3, 'run.completed', min(40))); // triggers a refresh
    await expect(laneOf(page).getByText(/Following 4 of 4 runs/)).toBeVisible();
    await tick(page, 500);
    expect(await instancesOf(page, 'run-a')).toBe(instances); // no EventSource for run-a
    await expect(statusText(page)).toContainText('1 stopped after retries');

    await fake.setDown(page, 'run-a', false);
    await page.getByRole('button', { name: 'Refresh data' }).dispatchEvent('click');
    await tick(page, 20);
    expect(await instancesOf(page, 'run-a')).toBe(instances + 1); // Refresh permits it
  });

  test('a partly spent budget survives temporary eviction', async ({ page }) => {
    const api = await openFrozen(page, [a, b, c, d], [a, b, c, d, e]);
    await expect(laneOf(page).getByText(/Following 4 of 4 runs/)).toBeVisible();
    await fail(page, 'run-a', 3);
    expect(await errorsOf(page, 'run-a')).toBe(3);

    api.setRuns([a, b, c, d, e]);
    await fake.publish(page, 'run-d', runEvent('run-d', 3, 'run.completed', min(40)));
    await expect(laneOf(page).getByText(/Following 4 of 5 runs/)).toBeVisible();
    await expect(nodesOf(page, 'run-a')).toHaveCount(0); // evicted
    await tick(page, 200);
    expect(await errorsOf(page, 'run-a')).toBe(3); // an evicted run makes no attempts

    api.setRuns([a, b, c, d]);
    await fake.publish(page, 'run-c', runEvent('run-c', 3, 'run.completed', min(41)));
    await expect(laneOf(page).getByText(/Following 4 of 4 runs/)).toBeVisible();
    await tick(page, 1); // re-entry: the first attempt is cumulative failure 4
    expect(await errorsOf(page, 'run-a')).toBe(4);
    await tick(page, 20); // cumulative failure 5
    expect(await errorsOf(page, 'run-a')).toBe(5);
    await expect(statusText(page)).toContainText('1 stopped after retries');
  });

  test('a run that fails while another is evicted does not charge the other', async ({ page }) => {
    const api = await openFrozen(page, [a, b, c, d], [a, b, c, d, e]);
    await expect(laneOf(page).getByText(/Following 4 of 4 runs/)).toBeVisible();
    await fail(page, 'run-b', 2);
    api.setRuns([a, b, c, d, e]);
    await fake.publish(page, 'run-d', runEvent('run-d', 3, 'run.completed', min(40)));
    await expect(laneOf(page).getByText(/Following 4 of 5 runs/)).toBeVisible();
    expect(await errorsOf(page, 'run-a')).toBe(0);
    expect(await errorsOf(page, 'run-c')).toBe(0);
  });
});
