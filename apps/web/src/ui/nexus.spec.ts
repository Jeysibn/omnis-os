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
import { buildMissionEvents } from './nexus/missionEvents.js';
import { deriveReactorState, type ReactorInput } from './nexus/reactorState.js';
import { formatManilaStamp } from './nexus/time.js';
import { computeVitals } from './nexus/vitals.js';
import { csrf, mockApi, run, task, T0, type NexusApiOptions } from './nexusFixture.js';

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
  test('orders chronologically, dedupes, and never invents events for a queued run', () => {
    const runs = [
      run('b', 't', 'B', 'completed', '2026-11-03T03:00:00.000Z', '2026-11-03T02:00:00.000Z'),
      run('a', 't', 'A', 'queued', '2026-11-03T01:00:00.000Z', '2026-11-03T01:00:00.000Z'),
    ];
    const events = buildMissionEvents([...runs, ...runs]);
    expect(events.map((e) => e.id)).toEqual(['a:queued', 'b:queued', 'b:state']);
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
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
  await expect(page.getByRole('region', { name: 'Live mission lane' })).toBeVisible();
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
  const box = (await canvas.boundingBox())!;
  // Markers rest on their orbit; scan the stage for the marker instead of guessing geometry.
  let hit = false;
  for (let y = 0.1; y < 0.95 && !hit; y += 0.03) {
    for (let x = 0.05; x < 0.95 && !hit; x += 0.03) {
      await canvas.hover({ position: { x: box.width * x, y: box.height * y }, force: true });
      if ((await canvas.evaluate((el) => (el as HTMLElement).style.cursor)) === 'pointer') {
        await page.mouse.down();
        await page.mouse.up();
        hit = true;
      }
    }
  }
  expect(hit).toBe(true);
  await expect(page.locator('.nx-block[aria-labelledby="nx-selected-h"]')).toContainText(
    'Only run',
  );
});

test('mission lane is chronological, Manila-timed, pausable and expandable', async ({ page }) => {
  await open(page);
  const lane = page.getByRole('region', { name: 'Live mission lane' });
  const times = lane.locator('.nx-node time');
  await expect(times.first()).toContainText('09:00:00'); // 01:00Z queued run-old
  const stamps = await times.evaluateAll((els) => els.map((e) => e.getAttribute('datetime')!));
  expect(stamps).toEqual([...stamps].sort());
  await expect(lane.getByText(/No event stream is open on this screen/)).toBeVisible();
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
  await expect(page.getByText('No runs recorded.')).toBeVisible();
  await expect(page.getByText('No active run.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Active runs:\s*0/ })).toBeVisible();
  await expect(page.getByText('None recorded')).toBeVisible();
});

test('agents are never shown as executing', async ({ page }) => {
  await open(page);
  await expect(page.getByText(/does not report which agent handles a run/)).toBeVisible();
});

// ------------------------------------------------------------ graphics paths
test('reduced motion renders a static, non-blank reactor and no animation loop', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    let calls = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      calls++;
      return raf(cb);
    };
    (window as unknown as { __raf: () => number }).__raf = () => calls;
  });
  await open(page);
  await expect(page.locator('.reactor')).toHaveAttribute('data-reactor-mode', 'static');
  const nonBlank = await page.locator('canvas.reactor-canvas').evaluate((c: HTMLCanvasElement) => {
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 20) lit++;
    return lit;
  });
  expect(nonBlank).toBeGreaterThan(500);
  await page.waitForTimeout(300);
  const a = await page.evaluate(() => (window as unknown as { __raf: () => number }).__raf());
  await page.waitForTimeout(700);
  const b = await page.evaluate(() => (window as unknown as { __raf: () => number }).__raf());
  expect(b - a).toBeLessThan(5); // React/app frames only; no continuous reactor loop
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

test('rendering is paused when hidden and released on unmount', async ({ page }) => {
  await page.addInitScript(() => {
    let calls = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      calls++;
      return raf(cb);
    };
    (window as unknown as { __raf: () => number }).__raf = () => calls;
  });
  await open(page);
  const raf = () => page.evaluate(() => (window as unknown as { __raf: () => number }).__raf());
  await page.waitForTimeout(400);
  const running = (await raf()) - 0;
  await page.waitForTimeout(500);
  expect((await raf()) - running).toBeGreaterThan(15); // animating while visible

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(100);
  const hiddenStart = await raf();
  await page.waitForTimeout(600);
  expect((await raf()) - hiddenStart).toBeLessThan(3);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(300);
  const resumedStart = await raf();
  await page.waitForTimeout(400);
  expect((await raf()) - resumedStart).toBeGreaterThan(10);

  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.locator('canvas.reactor-canvas')).toHaveCount(0);
  await page.waitForTimeout(150);
  const after = await raf();
  await page.waitForTimeout(500);
  expect((await raf()) - after).toBeLessThan(3);
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
