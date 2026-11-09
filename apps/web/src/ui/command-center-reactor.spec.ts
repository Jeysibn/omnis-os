import { expect, test, type Page } from '@playwright/test';
import {
  makeRun,
  makeTask,
  mixedRuns,
  mockApi,
  open,
  vital,
  type Options,
} from './command-center.fixture.js';

/**
 * OMNIS NEXUS V2 Stage 2: the Reactor. The renderer is a Canvas 2D visualisation in a lazy chunk;
 * a static SVG built from the same geometry is the fallback and the whole reduced-motion
 * presentation. These tests cover the lifecycle (one loop, cleanup, pause), the failure paths, the
 * truthful state mapping, and that the Stage 1 layout and focus behaviour are untouched.
 */

const tasks = [makeTask('t-a', 'Prepare rollout', 'open', 9)];

/**
 * Counts live resources from the outside, so cleanup is measured, not assumed: animation frames
 * still pending, document `visibilitychange` listeners, and live Intersection/Resize observers.
 */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    type W = Window & {
      __frames: () => number;
      __visListeners: () => number;
      __observers: () => number;
      __hidden: (hidden: boolean) => void;
    };
    const w = window as unknown as W;
    const pending = new Set<number>();
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const id = raf((time) => {
        pending.delete(id);
        callback(time);
      });
      pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
      caf(id);
    };
    w.__frames = () => pending.size;

    let visListeners = 0;
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    const seen = new Map<EventListenerOrEventListenerObject, number>();
    document.addEventListener = ((type: string, listener: never, options?: never) => {
      if (type === 'visibilitychange') {
        visListeners += 1;
        seen.set(listener, (seen.get(listener) ?? 0) + 1);
      }
      return add(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, listener: never, options?: never) => {
      if (type === 'visibilitychange' && (seen.get(listener) ?? 0) > 0) {
        visListeners -= 1;
        seen.set(listener, (seen.get(listener) ?? 0) - 1);
      }
      return remove(type, listener, options);
    }) as typeof document.removeEventListener;
    w.__visListeners = () => visListeners;

    const live = new Set<unknown>();
    for (const name of ['IntersectionObserver', 'ResizeObserver'] as const) {
      const Native = window[name];
      const proto = Native.prototype as { observe: (t: Element) => void; disconnect: () => void };
      const observe = proto.observe;
      const disconnect = proto.disconnect;
      proto.observe = function (this: unknown, target: Element) {
        live.add(this);
        return observe.call(this, target);
      };
      proto.disconnect = function (this: unknown) {
        live.delete(this);
        return disconnect.call(this);
      };
    }
    w.__observers = () => live.size;

    let hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    });
    w.__hidden = (value) => {
      hidden = value;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
}

const frames = (page: Page) =>
  page.evaluate(() => (window as never as { __frames: () => number }).__frames());
const visListeners = (page: Page) =>
  page.evaluate(() => (window as never as { __visListeners: () => number }).__visListeners());
const observers = (page: Page) =>
  page.evaluate(() => (window as never as { __observers: () => number }).__observers());
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate(
    (value) => (window as never as { __hidden: (h: boolean) => void }).__hidden(value),
    hidden,
  );

const reactor = (page: Page) => page.locator('.ccx-reactor');
const canvas = (page: Page) => page.locator('canvas[data-reactor-canvas]');
const expectMode = (page: Page, expected: string, timeout = 10_000) =>
  expect(reactor(page)).toHaveAttribute('data-reactor-mode', expected, { timeout });

/** Sample a counter repeatedly and return the highest value seen. */
async function peak(page: Page, read: () => Promise<number>, samples = 8, gap = 120) {
  let max = 0;
  for (let i = 0; i < samples; i += 1) {
    max = Math.max(max, await read());
    await page.waitForTimeout(gap);
  }
  return max;
}

async function goToCommandCenter(page: Page) {
  await page.getByRole('link', { name: 'Command Center' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
}
async function leaveCommandCenter(page: Page) {
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
}

test.describe('lazy loading and enhanced rendering', () => {
  test('the renderer chunk is not requested away from the Command Center, and never blocks its data', async ({
    page,
  }) => {
    const requested: string[] = [];
    await page.route('**/command-center/reactor/ReactorCanvas*', async (route) => {
      requested.push(route.request().url());
      await new Promise((resolve) => setTimeout(resolve, 2_500)); // a slow network
      await route.continue();
    });
    mockApi(page, { tasks, runs: mixedRuns });
    await page.goto('/#tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await page.waitForTimeout(500);
    expect(requested, 'the Tasks screen must not load the renderer').toEqual([]);

    await goToCommandCenter(page);
    // While the chunk is still in flight the operational data is already on screen, and the stage
    // is not empty: the static Reactor is drawn.
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 2. Open Runs', {
      timeout: 2_000,
    });
    await expect(reactor(page)).toHaveAttribute('data-reactor-mode', 'loading');
    await expect(page.locator('svg[data-reactor-static]')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    await expectMode(page, 'enhanced');
    expect(requested).toHaveLength(1);
  });

  test('enhanced mode draws on a single canvas, swaps out the static drawing, and keeps one loop', async ({
    page,
  }) => {
    await instrument(page);
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectMode(page, 'enhanced');
    await expect(canvas(page)).toHaveCount(1);
    await expect(page.locator('svg[data-reactor-static]')).toHaveCount(0);
    const box = await canvas(page).evaluate((el: HTMLCanvasElement) => ({
      w: el.width,
      h: el.height,
      cw: el.clientWidth,
    }));
    expect(box.w).toBeGreaterThan(100);
    expect(box.w).toBe(box.h); // square
    await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'running');
    await expect(canvas(page)).toHaveAttribute('data-reactor-quality', 'full');
    // Never more than one scheduled frame from the Reactor, however long it runs.
    expect(await peak(page, () => frames(page), 15, 100)).toBeLessThanOrEqual(1);
  });

  test('the Reactor is decorative: hidden from assistive technology and never a Tab stop', async ({
    page,
  }) => {
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectMode(page, 'enhanced');
    await expect(reactor(page)).toHaveAttribute('aria-hidden', 'true');
    expect(await canvas(page).evaluate((el) => el.tabIndex)).toBe(-1);
    expect(
      await page
        .locator('.ccx-reactor *')
        .evaluateAll((els) => els.filter((el) => (el as HTMLElement).tabIndex >= 0).length),
    ).toBe(0);
    // Operational meaning stays in text: the state label sits next to it.
    await expect(
      page.getByRole('status').filter({ hasText: 'Mock execution active' }),
    ).toBeVisible();
  });
});

test.describe('reduced motion', () => {
  test('is a static drawing: no renderer chunk, no canvas, no animation frames', async ({
    page,
  }) => {
    await instrument(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const requested: string[] = [];
    await page.route('**/command-center/reactor/ReactorCanvas*', (route) => {
      requested.push(route.request().url());
      return route.continue();
    });
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectMode(page, 'reduced');
    await expect(page.locator('svg[data-reactor-static]')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    expect(await peak(page, () => frames(page), 10, 100)).toBe(0);
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(requested).toEqual([]);
  });

  test('switching the preference at run time swaps modes without losing focus or leaking a loop', async ({
    page,
  }) => {
    await instrument(page);
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectMode(page, 'enhanced');
    const create = page.getByRole('button', { name: 'Create task' });
    await create.focus();

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectMode(page, 'reduced');
    await expect(canvas(page)).toHaveCount(0);
    expect(await peak(page, () => frames(page), 6, 100)).toBe(0);
    await expect(create).toBeFocused();

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expectMode(page, 'enhanced');
    expect(await peak(page, () => frames(page), 10, 100)).toBeLessThanOrEqual(1);
    await expect(create).toBeFocused();
  });
});

test.describe('failure and fallback', () => {
  async function expectUsableFallback(page: Page) {
    await expectMode(page, 'fallback');
    await expect(page.locator('svg[data-reactor-static]')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    // The Command Center around it still works.
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 2. Open Runs');
    await expect(
      page.getByRole('status').filter({ hasText: 'Mock execution active' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'View runs' }).click();
    await expect(page).toHaveURL(/#runs$/);
  }

  test('the renderer chunk failing to load leaves the static drawing and a working page', async ({
    page,
  }) => {
    await page.route('**/command-center/reactor/ReactorCanvas*', (route) => route.abort());
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectUsableFallback(page);
  });

  test('no 2D canvas context falls back', async ({ page }) => {
    await page.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = () => null;
    });
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectUsableFallback(page);
  });

  test('a drawing error falls back instead of leaving a broken stage', async ({ page }) => {
    await page.addInitScript(() => {
      CanvasRenderingContext2D.prototype.createRadialGradient = () => {
        throw new Error('simulated GPU/driver failure');
      };
    });
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectUsableFallback(page);
  });

  test('a device too slow to draw it is downgraded, then falls back, and the loop stops', async ({
    page,
  }) => {
    test.setTimeout(45_000);
    await instrument(page);
    await page.addInitScript(() => {
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      CanvasRenderingContext2D.prototype.clearRect = function (
        ...args: [number, number, number, number]
      ) {
        const until = performance.now() + 30; // every frame costs 30 ms
        while (performance.now() < until);
        return clear.apply(this, args);
      };
    });
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expect(canvas(page)).toHaveAttribute('data-reactor-quality', 'lite', { timeout: 15_000 });
    await expectMode(page, 'fallback', 25_000);
    expect(await peak(page, () => frames(page), 6, 100)).toBe(0);
  });
});

test.describe('lifecycle', () => {
  test('leaving the Command Center releases every frame, listener and observer, over repeated visits', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await instrument(page);
    mockApi(page, { tasks, runs: mixedRuns });
    await page.goto('/#tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    const baseline = {
      frames: await frames(page),
      vis: await visListeners(page),
      obs: await observers(page),
    };

    for (let cycle = 0; cycle < 8; cycle += 1) {
      await goToCommandCenter(page);
      await expectMode(page, 'enhanced');
      await expect(canvas(page)).toHaveCount(1); // exactly one Reactor
      expect(
        await peak(page, () => frames(page), 4, 60),
        `visit ${cycle + 1}: one loop at most`,
      ).toBeLessThanOrEqual(1);
      await leaveCommandCenter(page);
      await expect(canvas(page)).toHaveCount(0);
      await expect
        .poll(
          async () => ({
            frames: await frames(page),
            vis: await visListeners(page),
            obs: await observers(page),
          }),
          {
            message: `after visit ${cycle + 1}`,
          },
        )
        .toEqual(baseline);
    }
  });

  test('a hidden tab or an off-screen stage stops the loop, and visibility resumes exactly one', async ({
    page,
  }) => {
    await instrument(page);
    await page.setViewportSize({ width: 390, height: 844 });
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expectMode(page, 'enhanced');
    await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'running');

    await setHidden(page, true);
    await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'idle');
    expect(await peak(page, () => frames(page), 6, 100)).toBe(0);
    await setHidden(page, false);
    await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'running');
    expect(await peak(page, () => frames(page), 8, 100)).toBeLessThanOrEqual(1);

    // Scrolled far enough that the stage is out of view.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'idle');
    expect(await peak(page, () => frames(page), 6, 100)).toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'running');
    expect(await peak(page, () => frames(page), 8, 100)).toBeLessThanOrEqual(1);
  });

  test('resizing keeps one loop and the canvas matches its box, across the 1200px boundary', async ({
    page,
  }) => {
    await instrument(page);
    mockApi(page, { tasks, runs: mixedRuns });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await expectMode(page, 'enhanced');
    for (const width of [1199, 1200, 1024, 768, 390, 320, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(canvas(page)).toHaveCount(1);
      await expect
        .poll(
          () =>
            canvas(page).evaluate((el: HTMLCanvasElement) => {
              const dpr = window.devicePixelRatio || 1;
              return (
                Math.abs(el.width - Math.round(el.clientWidth * Math.min(dpr, 2))) <= 1 &&
                el.clientWidth > 0
              );
            }),
          { message: `canvas matches its box at ${width}px` },
        )
        .toBe(true);
      expect(await peak(page, () => frames(page), 4, 60), `${width}px`).toBeLessThanOrEqual(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    }
  });
});

type StateCase = {
  name: string;
  options: Options;
  state: string;
  markers: string;
  moving: boolean;
};

const cases: StateCase[] = [
  {
    name: 'running work',
    options: { tasks, runs: mixedRuns },
    state: 'active',
    markers: 'running=1 stopping=1 queued=1 failed=1 interrupted=1 unknown=1',
    moving: true,
  },
  {
    name: 'nothing recorded',
    options: { tasks: [], runs: [] },
    state: 'idle',
    markers: 'none',
    moving: true,
  },
  {
    name: 'only completed runs',
    options: { tasks: [], runs: [makeRun('r1', 't1', 'Done', 'completed', 1)] },
    state: 'idle',
    markers: 'none',
    moving: true,
  },
  {
    name: 'a queued run',
    options: { tasks: [], runs: [makeRun('r1', 't1', 'Waiting', 'queued', 1)] },
    state: 'queued',
    markers: 'queued=1',
    moving: true,
  },
  {
    name: 'an outcome-unknown run',
    options: { tasks: [], runs: [makeRun('r1', 't1', 'Lost', 'unknown', 1)] },
    state: 'unknown',
    markers: 'unknown=1',
    moving: false,
  },
  {
    name: 'a failed latest run',
    options: { tasks: [], runs: [makeRun('r1', 't1', 'Broken', 'failed', 1)] },
    state: 'failed',
    markers: 'failed=1',
    moving: false,
  },
  {
    name: 'an interrupted latest run',
    options: { tasks: [], runs: [makeRun('r1', 't1', 'Cut', 'interrupted', 1)] },
    state: 'interrupted',
    markers: 'interrupted=1',
    moving: false,
  },
  {
    name: 'a cancelled latest run',
    options: { tasks: [], runs: [makeRun('r1', 't1', 'Stopped', 'cancelled', 1)] },
    state: 'cancelled',
    markers: 'none',
    moving: false,
  },
  {
    name: 'runs that failed to load',
    options: { tasks: [], runs: [], runsStatus: 503 },
    state: 'unavailable',
    markers: 'none',
    moving: false,
  },
];

test.describe('the Reactor says only what the data says', () => {
  for (const item of cases) {
    test(`${item.name}: state "${item.state}", markers "${item.markers}", ${item.moving ? 'ambient or active motion' : 'still'}`, async ({
      page,
    }) => {
      await instrument(page);
      mockApi(page, item.options);
      await open(page);
      await expectMode(page, 'enhanced');
      await expect(reactor(page)).toHaveAttribute('data-reactor-state', item.state);
      await expect(reactor(page)).toHaveAttribute('data-markers', item.markers);
      await expect(canvas(page)).toHaveAttribute('data-reactor-state', item.state);
      if (item.moving) {
        await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'running');
      } else {
        // States that are not "alive" settle after the intro and then draw nothing further.
        await expect(canvas(page)).toHaveAttribute('data-reactor-loop', 'idle', { timeout: 6_000 });
        expect(await peak(page, () => frames(page), 6, 100)).toBe(0);
      }
    });
  }

  test('loading shows no markers and no activity', async ({ page }) => {
    mockApi(page, { tasks, runs: mixedRuns, delayMs: 2_500 });
    await page.goto('/#command-center');
    await expect(reactor(page)).toHaveAttribute('data-reactor-state', 'loading');
    await expect(reactor(page)).toHaveAttribute('data-markers', 'none');
  });

  test('the text state and the Reactor state always agree', async ({ page }) => {
    for (const item of cases.slice(0, 3)) {
      await page.unrouteAll();
      mockApi(page, item.options);
      await page.goto('/#command-center');
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
      await expect(reactor(page)).toHaveAttribute('data-reactor-state', item.state);
      const label = { active: 'Mock execution active', idle: 'Idle' }[item.state]!;
      await expect(page.getByRole('status').filter({ hasText: label })).toBeVisible();
    }
  });
});

test.describe('Stage 1 behaviour is preserved', () => {
  test('keyboard focus is not disturbed by animation, and Tab never lands on the Reactor', async ({
    page,
  }) => {
    mockApi(page, { tasks, runs: mixedRuns });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await expectMode(page, 'enhanced');
    const create = page.getByRole('button', { name: 'Create task' });
    await create.focus();
    await page.waitForTimeout(1_500); // the loop runs; focus must not move
    await expect(create).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'View runs' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Review approvals' })).toBeFocused();
    const insideReactor = await page.evaluate(
      () => !!document.activeElement?.closest('.ccx-reactor'),
    );
    expect(insideReactor).toBe(false);
  });

  test('the stage and its controls are the same elements before and after the Reactor loads', async ({
    page,
  }) => {
    await page.route('**/command-center/reactor/ReactorCanvas*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      await route.continue();
    });
    mockApi(page, { tasks, runs: mixedRuns });
    await open(page);
    await expect(reactor(page)).toHaveAttribute('data-reactor-mode', 'loading');
    const create = page.getByRole('button', { name: 'Create task' });
    await create.focus();
    await create.evaluate((el) => ((el as HTMLElement).dataset.mark = 'same-node'));
    await expectMode(page, 'enhanced');
    await expect(create).toBeFocused(); // not remounted when the Reactor swapped in
    await expect(create).toHaveAttribute('data-mark', 'same-node');
  });

  // Maximum square size per layout. Below 1200px the stage is stacked, so the graphic is smaller.
  const widths = [
    { width: 1920, size: 500 },
    { width: 1440, size: 440 },
    { width: 1200, size: 440 },
    { width: 1199, size: 300 },
    { width: 1024, size: 300 },
    { width: 768, size: 300 },
    { width: 390, size: 200 },
    { width: 320, size: 192 },
  ];
  // "Create task" top edge on the merged Stage 1 page (static mark, no Reactor), measured at 900px
  // high with the same fixture, and the most the Reactor may push it down.
  const baselineDeckY: Record<number, number> = { 320: 781, 390: 788, 768: 653, 1440: 976 };
  // Allowed push: none on desktop (the side panels set the height), 150 on tablet, 110 on mobile.
  const maxPush: Record<number, number> = { 1440: 0, 768: 150, 390: 110, 320: 110 };
  for (const { width, size } of widths) {
    test(`${width}px: the Reactor fits its panel, is at most ${size}px square, and no control is pushed off screen`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      mockApi(page, { tasks, runs: mixedRuns });
      await open(page);
      await expectMode(page, 'enhanced');
      const box = (await reactor(page).boundingBox())!;
      const panel = (await page.locator('.ccx-state').boundingBox())!;
      expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
      expect(box.width).toBeLessThanOrEqual(size + 1);
      expect(box.x).toBeGreaterThanOrEqual(panel.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
      for (const name of ['Create task', 'View runs', 'Review approvals']) {
        const control = (await page.getByRole('button', { name, exact: true }).boundingBox())!;
        expect(control.x).toBeGreaterThanOrEqual(0);
        expect(control.x + control.width).toBeLessThanOrEqual(width);
      }
      // The graphic must not push the operational controls far down the page.
      const base = baselineDeckY[width];
      if (base !== undefined) {
        const deck = (await page.getByRole('button', { name: 'Create task' }).boundingBox())!;
        const y = deck.y + (await page.evaluate(() => window.scrollY));
        expect(y, `deck at ${width}px was ${base} before the Reactor`).toBeLessThanOrEqual(
          base + maxPush[width]!,
        );
      }
    });
  }
});

/**
 * Measurements, not assertions: set NEXUS_PERF=1 to print them. Headless Chromium rasterises Canvas 2D
 * in software, so these numbers say how much CPU the drawing costs, not what a GPU would do, and
 * they describe this machine only.
 */
test.describe('measurements (only when NEXUS_PERF is set)', () => {
  test.skip(!process.env.NEXUS_PERF, 'set NEXUS_PERF=1 to print measurements');
  test.use({ viewport: { width: 1440, height: 900 } });

  async function metrics(page: Page) {
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const read = async () => {
      const { metrics: list } = await session.send('Performance.getMetrics');
      return Object.fromEntries(list.map((m) => [m.name, m.value])) as Record<string, number>;
    };
    return { session, read };
  }

  async function cpuPercent(page: Page, seconds: number) {
    const { read } = await metrics(page);
    const a = await read();
    await page.waitForTimeout(seconds * 1000);
    const b = await read();
    return {
      task: ((b.TaskDuration! - a.TaskDuration!) / seconds) * 100,
      script: ((b.ScriptDuration! - a.ScriptDuration!) / seconds) * 100,
    };
  }

  test('CPU by mode and state, frame stability, load cost', async ({ page }) => {
    test.setTimeout(240_000);
    const lines: string[] = [];
    const scenarios: Array<{ name: string; options: Options; reduced?: boolean }> = [
      {
        name: 'reduced motion (static SVG, no renderer)',
        options: { tasks, runs: mixedRuns },
        reduced: true,
      },
      { name: 'enhanced, active (running work)', options: { tasks, runs: mixedRuns } },
      { name: 'enhanced, idle (ambient breathing)', options: { tasks: [], runs: [] } },
      {
        name: 'enhanced, unknown outcome (settled, no loop)',
        options: { tasks: [], runs: [makeRun('r', 't', 'Lost', 'unknown', 1)] },
      },
    ];
    for (const scenario of scenarios) {
      await page.unrouteAll();
      await page.emulateMedia({ reducedMotion: scenario.reduced ? 'reduce' : 'no-preference' });
      mockApi(page, scenario.options);
      const started = Date.now();
      await page.goto('/#command-center');
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
      await expect(reactor(page)).toHaveAttribute(
        'data-reactor-mode',
        scenario.reduced ? 'reduced' : 'enhanced',
        {
          timeout: 15_000,
        },
      );
      const toReady = Date.now() - started;
      await page.waitForTimeout(2_500); // past the 1.2 s intro
      const cpu = await cpuPercent(page, 5);
      const draw =
        (await canvas(page).count()) === 0
          ? 'n/a'
          : await canvas(page).evaluate(
              (el) => (el as HTMLCanvasElement).dataset.reactorDrawMs ?? 'n/a',
            );
      console.log(`SCENARIO done: ${scenario.name} in ${Date.now() - started} ms`);
      lines.push(
        `${scenario.name.padEnd(48)} CPU ${cpu.task.toFixed(1).padStart(5)}%  script ${cpu.script.toFixed(1).padStart(5)}%  draw ${draw} ms  ready ${toReady} ms`,
      );
    }
    // Frame stability while the active Reactor runs: spacing of display frames over 4 s.
    await page.unrouteAll();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    mockApi(page, { tasks, runs: mixedRuns });
    await page.goto('/#command-center');
    await page.reload();
    await expect(reactor(page)).toHaveAttribute('data-reactor-mode', 'enhanced', {
      timeout: 15_000,
    });
    await page.waitForTimeout(2_000);
    const stats = await page.evaluate(
      () =>
        new Promise<{ frames: number; avg: number; p95: number; worst: number }>((resolve) => {
          const gaps: number[] = [];
          let last = performance.now();
          const end = last + 4_000;
          const step = (now: number) => {
            gaps.push(now - last);
            last = now;
            if (now < end) requestAnimationFrame(step);
            else {
              gaps.sort((a, b) => a - b);
              resolve({
                frames: gaps.length,
                avg: gaps.reduce((a, b) => a + b, 0) / gaps.length,
                p95: gaps[Math.floor(gaps.length * 0.95)]!,
                worst: gaps[gaps.length - 1]!,
              });
            }
          };
          requestAnimationFrame(step);
        }),
    );
    lines.push(
      `frame spacing over 4 s (active)                  ${stats.frames} frames, avg ${stats.avg.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, worst ${stats.worst.toFixed(1)} ms`,
    );
    console.log('PERF\n' + lines.map((l) => '  ' + l).join('\n'));
  });

  test('heap, nodes and listeners after repeated visits', async ({ page }) => {
    test.setTimeout(120_000);
    mockApi(page, { tasks, runs: mixedRuns });
    const { session, read } = await metrics(page);
    await page.goto('/#tasks');
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    const settle = async () => {
      await session.send('HeapProfiler.collectGarbage');
      await page.waitForTimeout(300);
      await session.send('HeapProfiler.collectGarbage');
      return read();
    };
    // One warm-up visit so one-off module and cache allocation is not counted as a leak.
    await goToCommandCenter(page);
    await expectMode(page, 'enhanced');
    await leaveCommandCenter(page);
    const before = await settle();
    for (let cycle = 0; cycle < 30; cycle += 1) {
      await goToCommandCenter(page);
      await expectMode(page, 'enhanced');
      await leaveCommandCenter(page);
    }
    const after = await settle();
    console.log(
      `PERF-LEAK after 30 visits (GC forced): heap ${((after.JSHeapUsedSize! - before.JSHeapUsedSize!) / 1024).toFixed(0)} KB, ` +
        `nodes ${after.Nodes! - before.Nodes!}, listeners ${after.JSEventListeners! - before.JSEventListeners!}`,
    );
  });
});

/** Visual evidence (set NEXUS_SHOT_DIR): enhanced, reduced-motion and fallback at several sizes. */
test.describe('visual evidence (only when NEXUS_SHOT_DIR is set)', () => {
  test.skip(!process.env.NEXUS_SHOT_DIR, 'set NEXUS_SHOT_DIR to capture screenshots');

  async function snap(page: Page, name: string, target: 'page' | 'stage') {
    const path = `${process.env.NEXUS_SHOT_DIR}/${name}.jpg`;
    // A full-page capture taken while scrolled displaces fixed elements (the hidden skip link).
    await page.evaluate(() => window.scrollTo(0, 0));
    if (target === 'page')
      await page.screenshot({ path, type: 'jpeg', quality: 80, fullPage: true });
    else await page.locator('.ccx-stage').screenshot({ path, type: 'jpeg', quality: 80 });
  }

  test('modes, sizes and states', async ({ page }) => {
    test.setTimeout(90_000);
    mockApi(page, { tasks, runs: mixedRuns });
    await page.setViewportSize({ width: 1920, height: 1080 });
    await open(page);
    await expectMode(page, 'enhanced');
    await page.waitForTimeout(2_000);
    await snap(page, 'reactor-1920-enhanced-active', 'page');
    for (const width of [1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(canvas(page)).toHaveCount(1);
      await page.waitForTimeout(600);
      await snap(page, `reactor-${width}-enhanced-active`, width === 390 ? 'page' : 'stage');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expectMode(page, 'reduced');
    await snap(page, 'reactor-1440-reduced-motion', 'stage');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expectMode(page, 'enhanced');
    const states: Array<[string, Options]> = [
      ['idle', { tasks: [], runs: [] }],
      ['failed', { tasks: [], runs: [makeRun('r1', 't1', 'Broken import', 'failed', 1)] }],
      ['unknown', { tasks: [], runs: [makeRun('r1', 't1', 'Lost acknowledgement', 'unknown', 1)] }],
      ['unavailable', { tasks: [], runs: [], runsStatus: 503 }],
    ];
    for (const [name, options] of states) {
      await page.unrouteAll();
      mockApi(page, options);
      await page.reload();
      await expectMode(page, 'enhanced');
      await page.waitForTimeout(2_500);
      await snap(page, `reactor-1440-state-${name}`, 'stage');
    }
    // Fallback: the renderer chunk is unavailable.
    await page.unrouteAll();
    await page.route('**/command-center/reactor/ReactorCanvas*', (route) => route.abort());
    mockApi(page, { tasks, runs: mixedRuns });
    await page.reload();
    await expectMode(page, 'fallback');
    await snap(page, 'reactor-1440-fallback', 'stage');
  });
});
