import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  buildConstellation,
  hashString,
  mulberry32,
  orbitPoint,
  ORBITS,
} from './nexus/geometry.js';
import {
  addRunEvent,
  buildMissionEvents,
  deriveLaneStatus,
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

  test('lane status is only "live" while an unfinished run has an open stream', () => {
    const live = run('r', 't', 'R', 'running');
    const done = run('d', 't', 'D', 'completed');
    const d = (
      runs: (typeof live)[],
      health: Record<string, never | 'open' | 'connecting' | 'reconnecting' | 'ended' | 'failed'>,
      eventCount: number,
      paused = false,
    ) => deriveLaneStatus({ runs, health, eventCount, paused });
    expect(d([live], { r: 'open' }, 2)).toBe('live');
    expect(d([done], { d: 'open' }, 2)).toBe('loading'); // replaying finished history is not live
    expect(d([done], { d: 'ended' }, 2)).toBe('history');
    expect(d([live], { r: 'connecting' }, 0)).toBe('loading');
    expect(d([live], { r: 'reconnecting' }, 2)).toBe('reconnecting');
    expect(d([live], { r: 'failed' }, 2)).toBe('disconnected');
    expect(d([live], { r: 'failed' }, 0)).toBe('unavailable');
    expect(d([live], { r: 'open' }, 2, true)).toBe('disconnected'); // runs list unavailable
    expect(d([], {}, 0)).toBe('empty');
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

test('gives up after bounded retries, reports disconnected, and Refresh reconnects', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const api = await open(page);
  const lane = laneOf(page);
  await expect(lane.locator('[data-lane-status="live"]')).toBeVisible();
  api.hub.failWith('run-active', 503);
  api.hub.drop('run-active');
  // three retries with 1s, 2s and 4s backoff, then the lane stops trying
  await expect(lane.locator('[data-lane-status="disconnected"]')).toBeVisible({ timeout: 20_000 });
  await expect(nodesOf(page, 'run-active')).toHaveCount(2); // history retained
  const attempts = () => api.hub.requests.filter((r) => r.runId === 'run-active').length;
  const settled = attempts();
  await page.waitForTimeout(1500);
  expect(attempts()).toBe(settled); // no unbounded retry loop

  api.hub.failWith('run-active', null);
  await page.getByRole('button', { name: 'Refresh data' }).click();
  await expect(lane.locator('[data-lane-status="live"]')).toBeVisible();
  await expect(nodesOf(page, 'run-active')).toHaveCount(2);
});

test('lane says the event source is unavailable when no history could be loaded', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const api = await mockApi(page, {
    runs: [run('run-x', 'task-x', 'Only run', 'running', min(5), min(1))],
  });
  api.hub.failWith('run-x', 503);
  await page.goto('/#command-center');
  await expect(laneOf(page).locator('[data-lane-status="unavailable"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(laneOf(page).getByText(/event source could not be reached/i)).toBeVisible();
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
