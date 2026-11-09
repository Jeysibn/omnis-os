import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import {
  mixedRuns,
  makeRun,
  makeTask,
  mockApi,
  open,
  region,
  shoot,
  vital,
} from './command-center.fixture.js';

test.describe('rendering and data', () => {
  test('renders the V2 surface from real task and run data', async ({ page }) => {
    const api = mockApi(page, {
      tasks: [
        makeTask('t-a', 'Prepare rollout', 'open', 2),
        makeTask('t-b', 'Old audit', 'completed', 1),
      ],
      runs: [makeRun('r-1', 't-b', 'Old audit', 'completed', 1)],
    });
    await open(page);
    const strip = page.getByRole('list', { name: 'Environment and connection' });
    await expect(strip).toContainText('Local workspace');
    await expect(strip).toContainText('Mock-only, synthetic');
    await expect(strip).toContainText('API: responding');
    await expect(strip).toContainText('Mock adapter');
    // Exactly one h1; the panels are h2 (and h3 inside them), in document order.
    const headings = await page
      .locator('#main-content')
      .getByRole('heading')
      .evaluateAll((els) =>
        els.map((el) => `${el.tagName}:${el.textContent?.trim().replace(/\s+/g, ' ')}`),
      );
    expect(headings.filter((h) => h.startsWith('H1:'))).toEqual(['H1:Command Center']);
    expect(headings).toEqual(
      expect.arrayContaining([
        'H2:System state',
        'H2:System vitals',
        'H3:System context',
        'H2:Requires attention',
        'H2:Recent tasks',
        'H2:Recent runs',
      ]),
    );
    await expect(
      page.getByText('Mock activity is synthetic and never provider activity.'),
    ).toBeVisible();
    expect(api.unexpected).toEqual([]);
  });

  test('vitals are computed from the loaded lists and keep unknown apart from failed', async ({
    page,
  }) => {
    mockApi(page, {
      tasks: [
        makeTask('t-a', 'Open one'),
        makeTask('t-b', 'Open two'),
        makeTask('t-c', 'Done', 'completed'),
      ],
      runs: mixedRuns,
    });
    await open(page);
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 2. Open Runs'); // running + stopping
    await expect(vital(page, 'Queued')).toHaveAccessibleName('Queued: 1. Open Runs');
    await expect(vital(page, 'Open tasks')).toHaveAccessibleName('Open tasks: 2. Open Tasks');
    await expect(vital(page, 'Failed or interrupted')).toHaveAccessibleName(
      'Failed or interrupted: 2. Open Runs',
    );
    await expect(vital(page, 'Outcome unknown')).toHaveAccessibleName(
      'Outcome unknown: 1. Open Runs',
    );
    await expect(page.getByText('Last recorded run update:')).toContainText(
      'Nov 3, 2026, 4:30 PM PHT',
    );
  });

  test('a confirmed zero is shown as 0 and an empty workspace says so', async ({ page }) => {
    mockApi(page, { tasks: [], runs: [] });
    await open(page);
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 0. Open Runs');
    await expect(page.getByText('Last recorded run update:')).toContainText('None recorded');
    await expect(page.getByText('No tasks yet')).toBeVisible();
    await expect(page.getByText('No runs yet')).toBeVisible();
    await expect(page.getByText('No active run.')).toBeVisible();
    await expect(page.getByText('No open task is waiting for a start decision.')).toBeVisible();
    await expect(
      page.getByText('No failed, interrupted or unknown-outcome runs recorded.'),
    ).toBeVisible();
    await expect(page.getByText('Idle', { exact: true })).toBeVisible();
  });

  test('loading never shows zero and is announced', async ({ page }) => {
    mockApi(page, { tasks: [], runs: [], delayMs: 1_500 });
    await page.goto('/#command-center');
    await expect(page.getByRole('status').filter({ hasText: 'Loading tasks…' })).toBeVisible();
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading system state' }),
    ).toBeVisible();
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: Loading. Open Runs');
    await expect(vital(page, 'Running')).not.toHaveAccessibleName(/: 0\./);
    await expect(page.getByText('Idle', { exact: true })).toHaveCount(0);
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 0. Open Runs');
  });

  test('a failed request is reported once, never as zero or empty, and can be retried', async ({
    page,
  }) => {
    const api = mockApi(page, {
      tasks: [makeTask('t-a', 'Prepare rollout')],
      runs: [],
      runsStatus: 503,
    });
    await open(page);
    await expect(page.getByText('Runs unavailable')).toHaveCount(1);
    await expect(
      page.getByRole('alert').filter({ hasText: 'Runs are temporarily unavailable.' }),
    ).toBeVisible();
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: Unavailable. Open Runs');
    await expect(page.getByText('System state unavailable')).toBeVisible();
    await expect(page.getByText('No runs yet')).toHaveCount(0);
    await expect(page.getByText('Idle', { exact: true })).toHaveCount(0);
    await expect(page.getByText('API: a request failed')).toBeVisible();
    await expect(page.getByText('Tasks unavailable')).toHaveCount(0);

    api.state.runsStatus = 200;
    await page.getByRole('button', { name: 'Retry runs' }).click();
    await expect(page.getByText('Runs unavailable')).toHaveCount(0);
    await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 0. Open Runs');
    await expect(page.getByText('Idle', { exact: true })).toBeVisible();
  });
});

test.describe('attention panel and status', () => {
  test('lists only supported attention categories, with text for every status', async ({
    page,
  }) => {
    mockApi(page, {
      tasks: [
        makeTask('t-1', 'Finished report', 'completed'),
        makeTask('t-3', 'Live analysis', 'open'), // has an active run: not awaiting a decision
        makeTask('t-9', 'Brand new task', 'open', 9),
      ],
      runs: mixedRuns,
    });
    await open(page);
    const attention = region(page, 'Requires attention');
    // Awaiting decision: only the open task with no active run.
    const awaiting = attention.getByRole('heading', { name: /Awaiting your decision/ });
    await expect(awaiting).toContainText('1');
    await expect(
      attention.getByRole('button', { name: 'Review approval to start Brand new task' }),
    ).toBeVisible();
    await expect(
      attention.getByRole('button', { name: /Review approval to start Live analysis/ }),
    ).toHaveCount(0);
    // Current activity: queued, running and stopping, each with its text label.
    for (const [title, label] of [
      ['Live analysis', 'Running'],
      ['Winding down', 'Stopping'],
      ['Waiting job', 'Queued'],
    ] as const)
      await expect(
        attention.getByRole('button', { name: new RegExp(`^${label}\\s+${title}`) }),
      ).toBeVisible();
    // Priority events: failed, interrupted and unknown, newest update first.
    const priority = attention.locator('.ccx-block').nth(2);
    await expect(priority.getByRole('heading')).toContainText('Priority events');
    await expect(priority.locator('.ccx-item-title')).toHaveText([
      'Broken import',
      'Cut-off sync',
      'Lost acknowledgement',
    ]);
    await expect(priority.getByRole('button', { name: /^Failed\s+Broken import/ })).toBeVisible();
    await expect(
      priority.getByRole('button', { name: /^Interrupted\s+Cut-off sync/ }),
    ).toBeVisible();
    await expect(
      priority.getByRole('button', { name: /^Outcome unknown\s+Lost acknowledgement/ }),
    ).toBeVisible();
    // Unknown is never shown as completed, and says it is unverified.
    const unknown = attention.getByRole('button', { name: /Lost acknowledgement/ });
    await expect(unknown).not.toContainText('Completed');
    await expect(unknown).toContainText('Not verified as completed or failed.');
    // Nothing invented: no security alert, agent or approval-queue content.
    await expect(page.getByText(/security alert|agent online|pending approvals?:/i)).toHaveCount(0);
    await expect(attention).toContainText('the API has no list of pending approvals');
  });

  test('every run status has a distinct text label (completed and cancelled in records)', async ({
    page,
  }) => {
    mockApi(page, { tasks: [], runs: mixedRuns });
    await open(page);
    const records = region(page, 'Recent runs');
    await expect(records.getByText('Completed', { exact: true })).toBeVisible();
    await expect(records.getByText('Cancelled', { exact: true })).toBeVisible();
    const labels = await page.locator('.nx-status').allTextContents();
    for (const label of [
      'Queued',
      'Running',
      'Stopping',
      'Completed',
      'Cancelled',
      'Failed',
      'Interrupted',
    ])
      expect(labels).toContain(label);
    expect(labels).toContain('Outcome unknown');
  });

  test('the system state never calls an unknown outcome idle or completed', async ({ page }) => {
    mockApi(page, {
      tasks: [],
      runs: [
        makeRun('r-u', 't-u', 'Lost acknowledgement', 'unknown', 1),
        makeRun('r-c', 't-c', 'Fine', 'completed', 2),
      ],
    });
    await open(page);
    const stage = region(page, 'System state');
    await expect(stage.getByRole('status')).toContainText('Outcome unknown');
    await expect(stage).not.toContainText('Idle');
    await expect(stage).toContainText('not recorded as completed or failed');
  });

  test('Review approval opens the existing approval dialog and changes nothing on cancel', async ({
    page,
  }) => {
    const api = mockApi(page, { tasks: [makeTask('t-a', 'Prepare rollout')], runs: [] });
    await open(page);
    const trigger = page.getByRole('button', { name: 'Review approval to start Prepare rollout' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Approve one synthetic run?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(api.mutations()).toEqual([]);
  });
});

test.describe('clock, navigation and scope', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });

  test('the PHT clock shows Asia/Manila time regardless of the browser timezone and ticks per minute', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    mockApi(page, { tasks: [], runs: [] });
    // 2026-11-03T20:30:10Z is 12:30 in Los Angeles but 04:30 on Wed 4 Nov in Manila.
    await page.clock.install({ time: new Date('2026-11-03T20:30:10Z') });
    await open(page);
    expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe(
      'America/Los_Angeles',
    );
    const clock = page.locator('.ccx-clock time');
    await expect(clock).toHaveText('Wed, Nov 04, 04:30');
    await expect(page.locator('.ccx-clock')).toContainText('PHT');
    // The installed clock keeps ticking, so pin the instant to the minute rather than the second.
    await expect(clock).toHaveAttribute('datetime', /^2026-11-03T20:30:\d\d\.\d{3}Z$/);
    await page.clock.runFor(60_000);
    await expect(clock).toHaveText('Wed, Nov 04, 04:31');
    // Leaving the route unmounts the clock; its timer must not fire into a dead component.
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    await page.clock.runFor(180_000);
    expect(errors).toEqual([]);
  });

  test('buttons lead to the existing task and run screens', async ({ page }) => {
    mockApi(page, {
      tasks: [makeTask('t-a', 'Prepare rollout')],
      runs: [makeRun('run-old', 't-a', 'Audit access notes', 'completed', 1)],
    });
    await open(page);
    await region(page, 'Recent runs')
      .getByRole('button', { name: /Audit access notes/ })
      .click();
    await expect(page).toHaveURL(/#runs\/run-old$/);
    await expect(page.getByRole('heading', { name: 'Run inspector' })).toBeVisible();
    await page.getByRole('link', { name: 'Command Center' }).click();
    await page.getByRole('button', { name: 'All tasks' }).click();
    await expect(page).toHaveURL(/#tasks$/);
    await page.getByRole('link', { name: 'Command Center' }).click();
    await vital(page, 'Open tasks').click();
    await expect(page).toHaveURL(/#tasks$/);
    await page.getByRole('link', { name: 'Command Center' }).click();
    await page.getByRole('button', { name: 'View runs' }).click();
    await expect(page).toHaveURL(/#runs$/);
    await page.getByRole('link', { name: 'Command Center' }).click();
    await page.getByRole('button', { name: 'Create task' }).click();
    await expect(page).toHaveURL(/#tasks$/);
    await expect(page.getByLabel('Task title')).toBeFocused();
  });

  test('the dark environment is scoped to this route only', async ({ page }) => {
    mockApi(page, { tasks: [], runs: [] });
    await open(page);
    const background = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await background('.app-shell')).toBe('rgb(6, 12, 14)');
    await page.getByRole('link', { name: 'Tasks' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeVisible();
    expect(await background('.app-shell')).not.toBe('rgb(6, 12, 14)');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(244, 246, 249)',
    );
  });
});

test.describe('keyboard, focus and motion', () => {
  test('controls are reachable by keyboard with a visible focus indicator', async ({ page }) => {
    mockApi(page, {
      tasks: [makeTask('t-a', 'Prepare rollout')],
      runs: [makeRun('r-1', 't-b', 'Live analysis', 'running', 1)],
    });
    await open(page);
    const names = ['Create task', 'View runs', 'Review approvals'];
    await page.getByRole('button', { name: 'Create task' }).focus();
    for (const [index, name] of names.entries()) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeFocused();
      const outline = await button.evaluate((el) => {
        const style = getComputedStyle(el);
        return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
      });
      expect(outline.style).not.toBe('none');
      expect(outline.width).toBeGreaterThanOrEqual(2);
      if (index < names.length - 1) await page.keyboard.press('Tab');
    }
    // "Review approvals" moves focus to the approvals group without changing the route.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: /Awaiting your decision/ })).toBeFocused();
    await expect(page).toHaveURL(/#command-center$/);
    // Tab continues into the approvals actions, then the activity and stop controls.
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Review approval to start Prepare rollout' }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /^Running\s+Live analysis/ })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Request stop for Live analysis' }),
    ).toBeFocused();
  });

  for (const reduced of [false, true]) {
    test(`nothing animates in the ready state (prefers-reduced-motion: ${reduced ? 'reduce' : 'no-preference'})`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
      mockApi(page, { tasks: [makeTask('t-a', 'Prepare rollout')], runs: mixedRuns });
      await open(page);
      await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 2. Open Runs');
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      if (reduced) {
        const moving = await page.locator('.ccx-root, .ccx-root *').evaluateAll(
          (els) =>
            els.filter((el) => {
              const style = getComputedStyle(el);
              return style.animationName !== 'none' || parseFloat(style.transitionDuration) > 0;
            }).length,
        );
        expect(moving).toBe(0);
      }
    });
  }
});

test.describe('responsive layout', () => {
  const widths = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ];
  for (const viewport of widths) {
    test(`${viewport.width}px: no overflow, nothing clipped, correct order, axe clean`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      mockApi(page, {
        tasks: [
          makeTask(
            't-a',
            'A task with a deliberately long title that has to wrap on narrow screens',
          ),
        ],
        runs: mixedRuns,
      });
      await open(page);
      await expect(vital(page, 'Running')).toHaveAccessibleName('Running: 2. Open Runs');
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        main: (() => {
          const main = document.getElementById('main-content')!;
          return main.scrollWidth - main.clientWidth;
        })(),
      }));
      expect(overflow).toEqual({ page: 0, main: 0 });
      // Essential controls are fully inside the viewport horizontally.
      for (const name of ['Create task', 'View runs', 'Review approvals']) {
        const box = await page.getByRole('button', { name, exact: true }).boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      }
      const top = async (name: string) => (await region(page, name).boundingBox())!;
      const [stage, attention, vitals] = await Promise.all([
        top('System state'),
        top('Requires attention'),
        top('System vitals'),
      ]);
      if (viewport.width >= 1200) {
        expect(vitals.x).toBeLessThan(stage.x);
        expect(stage.x).toBeLessThan(attention.x);
        expect(Math.abs(vitals.y - attention.y)).toBeLessThan(60);
      } else if (viewport.width >= 720) {
        expect(stage.y).toBeLessThan(attention.y); // stage first, then attention and vitals side by side
        expect(attention.x).toBeLessThan(vitals.x);
      } else {
        expect(stage.y).toBeLessThan(attention.y); // single column: attention before vitals
        expect(attention.y).toBeLessThan(vitals.y);
      }
      await shoot(page, `command-center-${viewport.width}`);
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
      ).toEqual([]);
    });
  }
});

test.describe('visual evidence (only when NEXUS_SHOT_DIR is set)', () => {
  test.skip(!process.env.NEXUS_SHOT_DIR, 'set NEXUS_SHOT_DIR to capture screenshots');
  test.use({ viewport: { width: 1440, height: 900 } });

  test('empty, unavailable and unknown-outcome states', async ({ page }) => {
    mockApi(page, { tasks: [], runs: [] });
    await open(page);
    await expect(page.getByText('No tasks yet')).toBeVisible();
    await shoot(page, 'state-empty-1440');
    await page.unrouteAll();
    mockApi(page, { tasks: [], runs: [], runsStatus: 503, tasksStatus: 503 });
    await page.reload(); // same URL: goto would only change the hash and keep the old state
    await expect(page.getByText('Runs unavailable')).toBeVisible();
    await shoot(page, 'state-unavailable-1440');
    await page.unrouteAll();
    mockApi(page, { tasks: [makeTask('t-a', 'Prepare rollout')], runs: mixedRuns });
    await page.reload();
    await expect(vital(page, 'Outcome unknown')).toHaveAccessibleName(
      'Outcome unknown: 1. Open Runs',
    );
    await shoot(page, 'state-mixed-1440');
  });
});
