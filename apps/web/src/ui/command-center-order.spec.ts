import { expect, test, type Page } from '@playwright/test';
import { makeTask, mixedRuns, mockApi, open, region } from './command-center.fixture.js';

/**
 * Reading order, Tab order and visual order of the Command Center must agree at every breakpoint.
 * axe cannot see this: every panel is individually accessible, so it is checked here by pressing
 * Tab in a real browser and comparing where focus lands with where the panels are drawn.
 *
 * Wide (>= 1200px):  vitals | stage | attention   (the V2 composition, left to right)
 * Narrower:          stage, then attention (left) and vitals (right) on tablet, one column on mobile
 */

const WIDE = ['System vitals', 'System state', 'Requires attention', 'Recent tasks', 'Recent runs'];
const NARROW = [
  'System state',
  'Requires attention',
  'System vitals',
  'Recent tasks',
  'Recent runs',
];
const expectedPanels = (width: number) => (width >= 1200 ? WIDE : NARROW);

const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

type Stop = {
  label: string;
  panel: string;
  x: number;
  y: number;
  inViewport: boolean;
  outline: { style: string; width: number };
};
type Box = { left: number; top: number; right: number; bottom: number };

const tasks = [makeTask('t-a', 'Prepare rollout', 'open', 9)];

/** Press Tab from the start of main until focus leaves the Command Center, recording each stop. */
async function tabThrough(page: Page): Promise<Stop[]> {
  await page.locator('#main-content').focus();
  const stops: Stop[] = [];
  for (let index = 0; index < 80; index += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest('.ccx-root')) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const panel = el.closest('.ccx-stage')
        ? 'System state'
        : el.closest('.ccx-vitals')
          ? 'System vitals'
          : el.closest('.ccx-attention')
            ? 'Requires attention'
            : (el.closest('section.nx-panel')?.getAttribute('aria-label') ?? 'other');
      return {
        label: (el.getAttribute('aria-label') ?? el.innerText).replace(/\s+/g, ' ').trim(),
        panel,
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        inViewport: rect.left >= 0 && rect.right <= window.innerWidth,
        outline: { style: style.outlineStyle, width: parseFloat(style.outlineWidth) },
      };
    });
    if (!stop) break;
    stops.push(stop);
  }
  return stops;
}

async function panelBoxes(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const find = (name: string) =>
      name === 'System state'
        ? document.querySelector('.ccx-stage')
        : document.querySelector(`section[aria-label="${name}"]`);
    const out: Record<string, Box> = {};
    for (const name of [
      'System state',
      'System vitals',
      'Requires attention',
      'Recent tasks',
      'Recent runs',
    ]) {
      const rect = find(name)!.getBoundingClientRect();
      out[name] = {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
        right: rect.right + window.scrollX,
        bottom: rect.bottom + window.scrollY,
      };
    }
    return out;
  });
}

const collapse = (stops: Stop[]) =>
  stops.map((s) => s.panel).filter((panel, index, all) => index === 0 || all[index - 1] !== panel);

/** Reading direction: the next panel is wholly to the right of this one, or wholly below it. */
const follows = (a: Box, b: Box) => b.left >= a.right - 1 || b.top >= a.bottom - 1;

for (const viewport of viewports) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });

    test('Tab, DOM and visual order agree and every control is reachable', async ({ page }) => {
      mockApi(page, { tasks, runs: mixedRuns });
      await open(page);
      await expect(page.getByRole('button', { name: /^Running: 2\./ })).toBeVisible();
      const stops = await tabThrough(page);
      if (process.env.NEXUS_PRINT_ORDER)
        console.log(
          `ORDER ${viewport.width}\n` +
            stops.map((s) => `  ${s.panel.padEnd(19)}| ${s.label}`).join('\n'),
        );

      // 1. Tab visits the panels in the intended sequence, each exactly once (no jumping back).
      expect(collapse(stops)).toEqual(expectedPanels(viewport.width));

      // 2. That sequence is also the reading direction on screen: right of, or below, the last panel.
      const boxes = await panelBoxes(page);
      const sequence = expectedPanels(viewport.width);
      for (let i = 1; i < sequence.length; i += 1)
        expect(
          follows(boxes[sequence[i - 1]!]!, boxes[sequence[i]!]!),
          `${sequence[i]} should come after ${sequence[i - 1]} on screen`,
        ).toBe(true);

      // 3. Inside a panel, focus moves down, or to the right along the same row, never backwards.
      for (let i = 1; i < stops.length; i += 1) {
        const [prev, next] = [stops[i - 1]!, stops[i]!];
        if (prev.panel !== next.panel) continue;
        const below = next.y > prev.y + 14;
        const sameRowToTheRight = Math.abs(next.y - prev.y) <= 14 && next.x > prev.x;
        expect(below || sameRowToTheRight, `"${next.label}" should follow "${prev.label}"`).toBe(
          true,
        );
      }

      // 4. Nothing important is skipped.
      const labels = stops.map((s) => s.label);
      const expectedControls: RegExp[] = [
        /^Create task$/,
        /^View runs$/,
        /^Review approvals$/,
        /^Running: 2\./,
        /^Queued: 1\./,
        /^Open tasks: 1\./,
        /^Failed or interrupted: 2\./,
        /^Outcome unknown: 1\./,
        /^Review approval to start Prepare rollout$/,
        /^Running Live analysis/,
        /^Stopping Winding down/,
        /^Queued Waiting job/,
        /^Request stop for Live analysis$/,
        /^Request stop for Waiting job$/,
        /^Failed Broken import/,
        /^Interrupted Cut-off sync/,
        /^Outcome unknown Lost acknowledgement/,
        /^All tasks$/,
        /^All runs$/,
        /^Completed Finished report|Finished report .*Completed/,
      ];
      for (const control of expectedControls)
        expect(
          labels.some((label) => control.test(label)),
          `${control} should be reachable`,
        ).toBe(true);
      // The stopping run's "Stop requested" button is disabled, so it is correctly not a Tab stop.
      expect(labels.some((label) => /Stop requested/.test(label))).toBe(false);
      expect(new Set(labels).size).toBe(labels.length); // no control visited twice

      // 5. Focus is visible and on screen at every stop.
      for (const stop of stops) {
        expect(stop.outline.style, `${stop.label} focus outline`).not.toBe('none');
        expect(stop.outline.width, `${stop.label} focus outline width`).toBeGreaterThanOrEqual(2);
        expect(stop.inViewport, `${stop.label} inside the viewport`).toBe(true);
      }

      // 6. Reading order (DOM and accessibility tree) is the same sequence, with one panel each.
      const headings = await page
        .locator('.ccx-root')
        .getByRole('heading', { level: 2 })
        .allTextContents();
      expect(headings.map((h) => h.trim())).toEqual(expectedPanels(viewport.width));
      const tree = await page.locator('#main-content').ariaSnapshot();
      const positions = expectedPanels(viewport.width).map((name) =>
        tree.indexOf(`heading "${name}"`),
      );
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      for (const name of WIDE) await expect(region(page, name)).toHaveCount(1);

      // 7. No horizontal overflow.
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
    });
  });
}

test.describe('crossing the breakpoint', () => {
  test('the panel order follows the layout exactly at 1199 / 1200 and focus survives a resize', async ({
    page,
  }) => {
    mockApi(page, { tasks, runs: mixedRuns });
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const order = () =>
      page.locator('.ccx-root').getByRole('heading', { level: 2 }).allTextContents();
    expect(await order()).toEqual(WIDE);

    const create = page.getByRole('button', { name: 'Create task' });
    await create.focus();
    for (const [width, expected] of [
      [1199, NARROW],
      [1200, WIDE],
      [1100, NARROW],
      [1280, WIDE],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(order, { message: `order at ${width}px` }).toEqual(expected);
      await expect(create).toBeFocused(); // the stage is not remounted, so focus is not lost
      for (const name of WIDE) await expect(region(page, name)).toHaveCount(1); // never duplicated
      const stops = await tabThrough(page);
      expect(collapse(stops)).toEqual(expected);
      await create.focus();
    }
  });
});

/**
 * Focus must survive the layout swap AND stay perceivable. The vitals panel is rendered at a
 * different place in the document on either side of 1200px, so React unmounts and remounts it.
 * Keeping the focused element is not enough: the panel also moves on screen, so the restored
 * control must be inside the viewport with its focus ring visible. Everything below uses real
 * keyboard focus, document.activeElement and bounding-rectangle measurements.
 */
type Active = {
  label: string;
  panel: string;
  tag: string;
  scrollY: number;
  outline: { style: string; width: number };
  top: number;
  bottom: number;
  left: number;
  right: number;
  vw: number;
  vh: number;
  /** Something other than the control (a sticky header, an overlay) paints over its centre. */
  obscured: boolean;
};

/** Focus ring is a 2px outline offset by 2px; keep that much clear of every viewport edge. */
const RING = 4;

const active = (page: Page): Promise<Active> =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const panel = el.closest('.ccx-stage')
      ? 'System state'
      : el.closest('.ccx-vitals')
        ? 'System vitals'
        : el.closest('.ccx-attention')
          ? 'Requires attention'
          : el.closest('header, nav')
            ? 'Shell'
            : 'none';
    const hit = document.elementFromPoint(
      Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1),
      Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1),
    );
    return {
      label: (el.getAttribute('aria-label') ?? el.innerText ?? '').replace(/\s+/g, ' ').trim(),
      panel,
      tag: el.tagName,
      scrollY: window.scrollY,
      outline: { style: style.outlineStyle, width: parseFloat(style.outlineWidth) },
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      vw: window.innerWidth,
      vh: window.innerHeight,
      obscured: !(hit && (hit === el || el.contains(hit))),
    };
  });

/** The control and its focus ring are fully inside the viewport and not painted over. */
function expectPerceivable(a: Active, where: string) {
  expect(a.tag, `${where}: focus must not be on <body>`).toBe('BUTTON');
  expect(a.top, `${where}: top edge (ring clear of the viewport top)`).toBeGreaterThanOrEqual(RING);
  expect(a.bottom, `${where}: bottom edge (ring clear of the viewport bottom)`).toBeLessThanOrEqual(
    a.vh - RING,
  );
  expect(a.left, `${where}: left edge`).toBeGreaterThanOrEqual(RING);
  expect(a.right, `${where}: right edge`).toBeLessThanOrEqual(a.vw - RING);
  expect(a.obscured, `${where}: nothing may paint over the focused control`).toBe(false);
  expect(a.outline.style, `${where}: focus outline`).not.toBe('none');
  expect(a.outline.width).toBeGreaterThanOrEqual(2);
}

const vitalsPanels = (page: Page) => page.locator('section[aria-label="System vitals"]');
const orderOf = (page: Page) =>
  page.locator('.ccx-root').getByRole('heading', { level: 2 }).allTextContents();
const running = (page: Page) => page.getByRole('button', { name: /^Running: / });

async function resizeTo(page: Page, width: number, height = 900) {
  await page.setViewportSize({ width, height });
  await expect
    .poll(() => orderOf(page), { message: `layout at ${width}px` })
    .toEqual(width >= 1200 ? WIDE : NARROW);
}

/** Put the control in view the way a keyboard user would arrive at it, then focus it. */
async function focusInView(page: Page, name: RegExp) {
  const button = page.getByRole('button', { name });
  await button.scrollIntoViewIfNeeded();
  await button.focus();
}

test.describe('focus inside Vitals across the breakpoint', () => {
  test.beforeEach(async ({ page }) => {
    mockApi(page, { tasks, runs: mixedRuns });
  });

  test('desktop to narrow (1440x900 to 1199x900): same control, brought into view with the ring visible', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await running(page).focus();
    const before = await active(page);
    expectPerceivable(before, '1440 before');

    await resizeTo(page, 1199);
    const after = await active(page);
    if (process.env.NEXUS_PRINT_ORDER)
      console.log(
        `BOUNDS 1440->1199 top=${Math.round(after.top)} bottom=${Math.round(after.bottom)} vh=${after.vh} scrollY=${Math.round(after.scrollY)}`,
      );
    expect(after.panel).toBe('System vitals');
    expect(after.label).toMatch(/^Running: /); // the same logical control
    expectPerceivable(after, '1199 after');
    // Minimal scrolling: the control lands at the nearest edge (bottom), not centred or at the top.
    expect(after.bottom).toBeGreaterThan(after.vh - 60);
    expect(after.scrollY).toBeGreaterThan(0);
    await expect(vitalsPanels(page)).toHaveCount(1);

    // Natural order continues from there, and every control we land on stays on screen.
    await page.keyboard.press('Tab');
    const queued = await active(page);
    expect(queued.label).toMatch(/^Queued: /);
    expectPerceivable(queued, 'Tab to Queued');
    await page.keyboard.press('Shift+Tab');
    expect((await active(page)).label).toMatch(/^Running: /);
    await page.keyboard.press('Shift+Tab');
    const previous = await active(page);
    expect(previous.panel).toBe('Requires attention');
    expect(previous.label).toMatch(/^Outcome unknown Lost acknowledgement/);
    expectPerceivable(previous, 'Shift+Tab to the last Attention control');
  });

  test('narrow to desktop (390x844 to 1200x844): same control, brought into view with the ring visible', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await focusInView(page, /^Running: /); // the user has scrolled down to the vitals
    const before = await active(page);
    expectPerceivable(before, '390 before');
    expect(before.scrollY, 'the user is scrolled far down the narrow page').toBeGreaterThan(1000);

    await resizeTo(page, 1200, 844);
    const after = await active(page);
    if (process.env.NEXUS_PRINT_ORDER)
      console.log(
        `BOUNDS 390->1200 top=${Math.round(after.top)} bottom=${Math.round(after.bottom)} vh=${after.vh} scrollY=${Math.round(after.scrollY)}`,
      );
    expect(after.panel).toBe('System vitals');
    expect(after.label).toMatch(/^Running: /);
    expectPerceivable(after, '1200 after');
    // Minimal scrolling: aligned to the nearest (top) edge rather than centred.
    expect(after.top).toBeLessThan(80);
    await expect(vitalsPanels(page)).toHaveCount(1);

    await page.keyboard.press('Tab');
    const queued = await active(page);
    expect(queued.label).toMatch(/^Queued: /);
    expectPerceivable(queued, 'Tab to Queued');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab'); // wide order: nothing precedes Vitals inside the page
    expect((await active(page)).panel).not.toBe('System vitals');
  });

  test('a control that is already visible after the swap does not cause any scrolling', async ({
    page,
  }) => {
    // Tall viewport: both layouts fit, so nothing needs revealing.
    await page.setViewportSize({ width: 1440, height: 3000 });
    await open(page);
    await running(page).focus();
    for (const width of [1199, 1200, 1100, 1300]) {
      await resizeTo(page, width, 3000);
      const now = await active(page);
      expectPerceivable(now, `${width} tall`);
      expect(now.scrollY, `no scroll at ${width}px`).toBe(0);
    }
    // Scrolled a little, with the control still on screen on the other side of the swap.
    await page.setViewportSize({ width: 1100, height: 1400 });
    await expect.poll(() => orderOf(page)).toEqual(NARROW);
    await running(page).focus();
    await page.evaluate(() => window.scrollTo(0, 50));
    const start = (await active(page)).scrollY;
    expect(start).toBe(50);
    await resizeTo(page, 1200, 1400);
    const now = await active(page);
    expectPerceivable(now, '1100 to 1200 scrolled 50');
    expect(now.scrollY, 'already visible, so the page must not move').toBe(50);
  });

  test('crossing the breakpoint repeatedly keeps the same control, one panel, and always on screen', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    await page.getByRole('button', { name: /^Failed or interrupted: / }).focus();
    for (const width of [1199, 1200, 1199, 1200, 1100, 1300, 1199, 1920, 390, 1200]) {
      await resizeTo(page, width);
      const now = await active(page);
      expect(now.label, `focus at ${width}px`).toMatch(/^Failed or interrupted: /);
      expect(now.panel).toBe('System vitals');
      expectPerceivable(now, `${width}px`);
      await expect(vitalsPanels(page)).toHaveCount(1);
      await expect(page.getByRole('button', { name: /^Failed or interrupted: / })).toHaveCount(1);
    }
    // Rapid back-to-back changes with no waiting in between settle on the final layout, in view.
    for (const width of [1199, 1200, 1199, 1200, 1199, 1200])
      await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => orderOf(page)).toEqual(WIDE);
    const settled = await active(page);
    expect(settled.label).toMatch(/^Failed or interrupted: /);
    expectPerceivable(settled, 'after rapid resizes');
  });

  test('focus elsewhere is never stolen by the swap', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page);
    const checks = [
      { target: page.getByRole('button', { name: 'Create task' }), panel: 'System state' },
      {
        target: page.getByRole('button', { name: 'Review approval to start Prepare rollout' }),
        panel: 'Requires attention',
      },
      { target: page.getByRole('link', { name: 'Runs' }), panel: 'Shell' },
    ];
    // Scroll position is deliberately not asserted here: Chromium's own scroll anchoring may move
    // the page when the layout reflows; what must hold is that focus identity is untouched.
    for (const { target, panel } of checks) {
      await target.focus();
      const label = (await active(page)).label;
      for (const width of [1199, 1200]) {
        await resizeTo(page, width);
        const now = await active(page);
        expect(now.panel, `${panel} focus at ${width}px`).toBe(panel);
        expect(now.label).toBe(label);
      }
    }
    // Nothing focused at all: the swap must not invent focus inside Vitals.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await resizeTo(page, 1199);
    expect((await active(page)).tag).toBe('BODY');
  });

  test('the application header is not sticky or fixed, so it cannot cover a restored control', async ({
    page,
  }) => {
    // If this ever changes, restored controls need scroll-margin for the header height: revisit
    // VitalsPanel's scrolling and .ccx-vital-button's scroll-margin before relaxing this test.
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    expect(
      await page.evaluate(() => getComputedStyle(document.querySelector('header')!).position),
    ).not.toMatch(/sticky|fixed/);
  });

  test('leaving the Command Center does not leave a stale focus restoration behind', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await page.getByRole('button', { name: /^Queued: / }).focus();
    await page.getByRole('link', { name: 'Tasks' }).click(); // unmounts with focus in Vitals
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await page.setViewportSize({ width: 1199, height: 900 });
    await page.getByRole('link', { name: 'Command Center' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Command Center' })).toBeVisible();
    const back = await active(page);
    expect(back.panel, 'a returning visit must not restore old focus').not.toBe('System vitals');
    expect(back.scrollY, 'and must not scroll to a control it never focused').toBe(0);
    await resizeTo(page, 1440);
    expect((await active(page)).panel).not.toBe('System vitals');
    expect(errors).toEqual([]);
  });
});
