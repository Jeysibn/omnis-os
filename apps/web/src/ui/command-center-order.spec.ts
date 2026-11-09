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
