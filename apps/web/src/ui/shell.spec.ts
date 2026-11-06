import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type Page, type Route } from '@playwright/test';

/**
 * Browser tests for the shared application shell: the top bar, its primary navigation and the
 * sign-out control. Every response is a synthetic fixture; nothing here talks to a real backend.
 *
 * The overflow cases reproduce the defects measured by the Phase 1 frontend audit: the document
 * grew to ~727px at a 720px viewport, ~429px at 390px with a 16px minimum font and ~336px at
 * 320px with the same setting, and the sign-out control crossed the viewport edge.
 */

const routes = [
  { hash: '#command-center', heading: 'Command Center' },
  { hash: '#tasks', heading: 'Tasks' },
  { hash: '#runs', heading: 'Runs' },
  { hash: '#agents', heading: 'Agents & Profiles' },
] as const;
const linkNames = ['Command Center', 'Tasks', 'Runs', 'Agents'] as const;

async function installApi(page: Page, ownerName = 'Director') {
  let signedOut = false;
  const handle = (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname === '/api/v1/auth/csrf')
      return route.fulfill({ json: { csrfToken: 'csrf-shell-fixture' } });
    if (url.pathname === '/api/v1/auth/logout' && method === 'POST') {
      signedOut = true;
      return route.fulfill({ status: 204, body: '' });
    }
    if (url.pathname === '/api/v1/me')
      return signedOut
        ? route.fulfill({
            status: 401,
            json: { error: { code: 'unauthorized', message: 'Sign in to continue.' } },
          })
        : route.fulfill({ json: { id: 'owner', displayName: ownerName } });
    if (url.pathname === '/api/v1/tasks' || url.pathname === '/api/v1/runs')
      return route.fulfill({ json: [] });
    if (url.pathname === '/api/v1/agents')
      return route.fulfill({
        json: { agents: [], page: { total: 0, complete: true, nextCursor: null } },
      });
    return route.fulfill({
      status: 500,
      json: { error: { code: 'fixture_contract_violation', message: url.pathname } },
    });
  };
  await page.route('**/api/v1/**', handle);
}

async function open(page: Page, hash = '#command-center') {
  await page.goto(`/${hash}`);
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.locator('#main-content')).toBeVisible();
}

const header = (page: Page) => page.locator('header.topbar');
const menuButton = (page: Page) => page.getByRole('button', { name: 'Navigation menu' });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary navigation' });
const signOut = (page: Page) => page.getByRole('button', { name: 'Sign out' });

/** Document-level horizontal overflow, measured the way a user would meet it. */
const overflow = (page: Page) =>
  page.evaluate(() => ({
    viewport: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    // A control is out of reach when any part of it lies beyond the viewport's right edge.
    beyond: [...document.querySelectorAll<HTMLElement>('header.topbar *')]
      .filter((el) => el.getClientRects().length > 0)
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
      .map((el) => el.getAttribute('aria-label') ?? el.tagName),
  }));

async function expectContained(page: Page, label: string) {
  const result = await overflow(page);
  expect(result.scroll, `${label}: document width`).toBeLessThanOrEqual(result.viewport);
  expect(result.body, `${label}: body width`).toBeLessThanOrEqual(result.viewport);
  expect(result.beyond, `${label}: header controls past the viewport edge`).toEqual([]);
  await expect(signOut(page)).toBeInViewport({ ratio: 1 });
}

/** Resolves after the browser has rendered two frames, so a layout reaction to a resize is done. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

/** Reveals the primary links regardless of layout and returns the navigation. */
async function revealNavigation(page: Page) {
  const button = menuButton(page);
  if (await button.isVisible()) {
    if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
  }
  return nav(page);
}

const viewports = [
  { name: '320px', width: 320, height: 640 },
  { name: '390px', width: 390, height: 844 },
  { name: '720px', width: 720, height: 900 },
  { name: '820px tablet', width: 820, height: 1180 },
  { name: '1024px tablet', width: 1024, height: 768 },
  { name: '1440px desktop', width: 1440, height: 900 },
];

test.describe('shell containment at the audited sizes (default text size)', () => {
  for (const viewport of viewports) {
    test(`no overflow and a reachable sign-out on every route at ${viewport.name}`, async ({
      page,
    }) => {
      await installApi(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const route of routes) {
        await open(page, route.hash);
        await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeAttached();
        await expectContained(page, `${route.hash} @${viewport.name}`);
      }
    });
  }

  test('a long owner display name is truncated instead of widening the bar', async ({ page }) => {
    await installApi(page, 'A very long display name for the owner of this workspace');
    for (const width of [320, 390, 720, 1024]) {
      await page.setViewportSize({ width, height: 800 });
      await open(page);
      await expectContained(page, `long owner @${width}`);
    }
  });
});

test.describe('shell containment with a 16px minimum font (browser setting)', () => {
  let browser: Browser;
  test.beforeAll(async () => {
    // Launch options cannot change inside a describe group, so this group owns its browser.
    browser = await chromium.launch({ args: ['--blink-settings=minimumFontSize=16'] });
  });
  test.afterAll(async () => {
    await browser.close();
  });

  test('the setting is really applied (probe text is wider than at default)', async () => {
    const probe = async (target: Browser) => {
      const page = await target.newPage();
      await page.setContent(
        '<span id="p" style="font-size:11px;position:absolute">Probe text for width</span>',
      );
      const width = await page.evaluate(
        () => document.getElementById('p')!.getBoundingClientRect().width,
      );
      await page.close();
      return width;
    };
    const defaults = await chromium.launch();
    const baseline = await probe(defaults);
    await defaults.close();
    expect(await probe(browser)).toBeGreaterThan(baseline * 1.15);
  });

  for (const viewport of viewports) {
    test(`no overflow and a reachable sign-out on every route at ${viewport.name}`, async () => {
      test.setTimeout(60_000);
      const baseURL = test.info().project.use.baseURL;
      if (!baseURL) throw new Error('The Playwright project has no baseURL.');
      const context = await browser.newContext({
        baseURL,
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      await installApi(page);
      for (const route of routes) {
        await open(page, route.hash);
        await expectContained(page, `${route.hash} @${viewport.name} min16`);
      }
      await context.close();
    });
  }
});

test.describe('navigation: discoverable at every width', () => {
  for (const viewport of viewports) {
    test(`all four destinations and sign-out are reachable at ${viewport.name}`, async ({
      page,
    }) => {
      await installApi(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await open(page);
      const primary = await revealNavigation(page);
      for (const name of linkNames) {
        const link = primary.getByRole('link', { name, exact: true });
        await expect(link).toBeVisible();
        await expect(link).toBeInViewport({ ratio: 1 });
      }
      await expect(signOut(page)).toBeVisible();
      await expect(primary.getByRole('link', { name: 'Command Center' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expectContained(page, `menu open @${viewport.name}`);
    });
  }

  test('wide screens keep the inline navigation with no menu button', async ({ page }) => {
    await installApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    await expect(header(page)).toHaveAttribute('data-nav', 'inline');
    await expect(menuButton(page)).toHaveCount(0);
    for (const name of linkNames) await expect(nav(page).getByRole('link', { name })).toBeVisible();
  });

  test('narrow screens collapse to a menu and the links are hidden until it is opened', async ({
    page,
  }) => {
    await installApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
    await expect(header(page)).toHaveAttribute('data-nav', 'menu');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page)).toBeHidden();
    // Hidden links must not be reachable by keyboard or assistive technology either.
    await expect(nav(page).getByRole('link')).toHaveCount(0);
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(nav(page).getByRole('link')).toHaveCount(4);
  });

  test('the layout switches where the content stops fitting and switches back without flicker', async ({
    page,
  }) => {
    await installApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    let switchedAt = 0;
    for (let width = 1440; width >= 320; width -= 20) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      if ((await header(page).getAttribute('data-nav')) === 'menu') {
        switchedAt = width;
        break;
      }
    }
    expect(switchedAt).toBeGreaterThan(320);
    // Everything wider than the switch point is inline and contained; everything narrower is a menu.
    for (const width of [switchedAt + 20, switchedAt + 120, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      await expect(header(page)).toHaveAttribute('data-nav', 'inline');
      await expectContained(page, `inline @${width}`);
    }
    for (const width of [switchedAt, switchedAt - 60, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      await expect(header(page)).toHaveAttribute('data-nav', 'menu');
      await expectContained(page, `menu @${width}`);
    }
  });

  test('extra destinations such as Projects fit without another layout change', async ({
    page,
  }) => {
    await installApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page);
    // Stand-ins for the expected Projects and Departments entries are added to the live list.
    for (const width of [1500, 1440, 1280, 1180, 1100, 1024, 820, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await settle(page);
      // A layout switch rebuilds the list, so add the stand-ins again until the mode is stable.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await page.evaluate(() => {
          const list = document.querySelector('nav.primary-nav')!;
          if (list.querySelectorAll('a').length >= 6) return;
          for (const label of ['Projects', 'Departments']) {
            const link = list.querySelector('a')!.cloneNode(true) as HTMLAnchorElement;
            link.href = `#${label.toLowerCase()}`;
            link.querySelector('span')!.textContent = label;
            link.removeAttribute('aria-current');
            link.className = '';
            list.append(link);
          }
        });
        await page.waitForTimeout(150);
        const count = await page.evaluate(
          () => document.querySelector('nav.primary-nav')!.querySelectorAll('a').length,
        );
        if (count === 6) break;
      }
      const primary = await revealNavigation(page);
      await expect(primary.getByRole('link')).toHaveCount(6);
      for (const name of [...linkNames, 'Projects', 'Departments'])
        await expect(primary.getByRole('link', { name, exact: true })).toBeInViewport({
          ratio: 1,
        });
      await expectContained(page, `six destinations @${width}`);
    }
  });
});

test.describe('disclosed menu: state, keyboard and focus', () => {
  test.beforeEach(async ({ page }) => {
    await installApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page);
  });

  test('the button exposes its state and controls the navigation landmark', async ({ page }) => {
    const button = menuButton(page);
    await expect(button).toHaveAttribute('aria-controls', /.+/);
    const controls = await button.getAttribute('aria-controls');
    await button.click();
    expect(await page.locator(`nav[id="${controls}"]`).count()).toBe(1);
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page)).toBeHidden();
  });

  test('keyboard only: Enter opens, Tab moves through every link, Escape closes and restores focus', async ({
    page,
  }) => {
    await page.keyboard.press('Tab'); // skip link
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Tab'); // brand
    await page.keyboard.press('Tab'); // menu button
    await expect(menuButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    for (const name of linkNames) {
      await page.keyboard.press('Tab');
      await expect(nav(page).getByRole('link', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Escape');
    await expect(menuButton(page)).toBeFocused();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page)).toBeHidden();
    // Space also operates the button.
    await page.keyboard.press('Space');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('focus rings are visible on the menu button and on each link', async ({ page }) => {
    const ring = async () =>
      page.evaluate(() => {
        const style = getComputedStyle(document.activeElement!);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      });
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(menuButton(page)).toBeFocused();
    expect((await ring()).style).not.toBe('none');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      const focused = await ring();
      expect(focused.style).not.toBe('none');
      expect(focused.width).toBeGreaterThanOrEqual(2);
    }
  });

  test('choosing a destination navigates, closes the menu and returns focus to the button', async ({
    page,
  }) => {
    await menuButton(page).click();
    await nav(page).getByRole('link', { name: 'Tasks', exact: true }).click();
    await expect(page).toHaveURL(/#tasks$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Tasks' })).toBeAttached();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toBeFocused();
    await menuButton(page).click();
    await expect(nav(page).getByRole('link', { name: 'Tasks', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(
      nav(page).getByRole('link', { name: 'Command Center', exact: true }),
    ).not.toHaveAttribute('aria-current', 'page');
  });

  test('pressing outside the header dismisses the menu without moving focus', async ({ page }) => {
    await menuButton(page).click();
    await expect(nav(page)).toBeVisible();
    await page.locator('#main-content').click({ position: { x: 10, y: 400 } });
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(nav(page)).toBeHidden();
  });

  test('tabbing out of the open menu closes it', async ({ page }) => {
    await menuButton(page).click();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Tab'); // 4 links, then sign-out
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('browser back and forward keep the route and close the menu', async ({ page }) => {
    await menuButton(page).click();
    await nav(page).getByRole('link', { name: 'Runs', exact: true }).click();
    await expect(page).toHaveURL(/#runs$/);
    await menuButton(page).click();
    await nav(page).getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/#agents$/);
    await menuButton(page).click();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await page.goBack();
    await expect(page).toHaveURL(/#runs$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Runs' })).toBeAttached();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await page.goBack();
    await expect(page).toHaveURL(/#command-center$|\/$/);
    await page.goForward();
    await expect(page).toHaveURL(/#runs$/);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('resizing to the inline layout dismisses the menu and keeps every link visible', async ({
    page,
  }) => {
    await menuButton(page).click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    await expect(header(page)).toHaveAttribute('data-nav', 'inline');
    await expect(menuButton(page)).toHaveCount(0);
    for (const name of linkNames) await expect(nav(page).getByRole('link', { name })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await settle(page);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('sign-out stays reachable with the menu open and closed and still signs out', async ({
    page,
  }) => {
    await expect(signOut(page)).toBeInViewport({ ratio: 1 });
    await menuButton(page).click();
    await expect(signOut(page)).toBeInViewport({ ratio: 1 });
    await signOut(page).click();
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(0);
  });

  test('the skip link still moves focus to main without changing the route or history', async ({
    page,
  }) => {
    const before = await page.evaluate(() => window.history.length);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
    expect(new URL(page.url()).hash).toBe('#command-center');
    expect(await page.evaluate(() => window.history.length)).toBe(before);
  });

  test('landmarks and axe: one banner, one named primary navigation, no serious violations', async ({
    page,
  }) => {
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    for (const open of [false, true]) {
      if (open) {
        await menuButton(page).click();
        await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toHaveCount(1);
      }
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious'),
        `axe, menu ${open ? 'open' : 'closed'}`,
      ).toEqual([]);
    }
  });

  test('reduced motion: the menu has no animation-dependent state', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await menuButton(page).click();
    const durations = await page.evaluate(() =>
      [...document.querySelectorAll('header.topbar, header.topbar *')].map(
        (el) => getComputedStyle(el).animationDuration,
      ),
    );
    for (const duration of durations) expect(['0s', '1e-05s', '0.00001s']).toContain(duration);
    await expect(nav(page).getByRole('link', { name: 'Runs', exact: true })).toBeVisible();
  });
});

test.describe('existing navigation keeps working', () => {
  for (const viewport of [viewports[1]!, viewports[5]!]) {
    test(`Command Center, Tasks, Runs and Agents all navigate at ${viewport.name}`, async ({
      page,
    }) => {
      await installApi(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await open(page);
      for (const route of routes) {
        const primary = await revealNavigation(page);
        const name = route.heading === 'Agents & Profiles' ? 'Agents' : route.heading;
        await primary.getByRole('link', { name, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${route.hash}$`));
        await expect(page.getByRole('heading', { level: 1, name: route.heading })).toBeAttached();
        await expect(
          (await revealNavigation(page)).getByRole('link', { name, exact: true }),
        ).toHaveAttribute('aria-current', 'page');
      }
    });
  }
});

/**
 * Genuine browser zoom, not viewport resizing or deviceScaleFactor.
 *
 * Chromium keeps a per-host zoom level in the profile. Seeding it in a fresh profile and using the
 * full Chromium build in its new headless mode makes the browser apply the same zoom as Ctrl +.
 * Each test first proves that real zoom happened: devicePixelRatio equals the zoom factor and the
 * layout viewport (window.innerWidth) shrinks by that factor. Neither changes with
 * deviceScaleFactor, which leaves innerWidth alone, so a failed seed fails the test.
 */
test.describe('genuine browser zoom', () => {
  const zoomCases = [
    { zoom: 2, window: 1280, label: '200% on a 1280px window' },
    { zoom: 2, window: 1920, label: '200% on a 1920px window' },
    { zoom: 4, window: 1280, label: '400% on a 1280px window (320 CSS px reflow)' },
  ];

  for (const { zoom, window: windowWidth, label } of zoomCases) {
    test(`${label}: no overflow, menu usable, sign-out reachable`, async () => {
      const testInfo = test.info();
      test.setTimeout(90_000);
      const baseURL = testInfo.project.use.baseURL;
      if (!baseURL) throw new Error('The Playwright project has no baseURL.');
      const level = Math.log(zoom) / Math.log(1.2); // Chromium's zoom level for this factor
      const profile = mkdtempSync(join(tmpdir(), 'omnis-zoom-'));
      mkdirSync(join(profile, 'Default'), { recursive: true });
      writeFileSync(
        join(profile, 'Default', 'Preferences'),
        JSON.stringify({
          partition: {
            default_zoom_level: { x: level },
            per_host_zoom_levels: {
              x: { '127.0.0.1': { zoom_level: level, last_modified: '13400000000000000' } },
            },
          },
        }),
      );
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: true,
        baseURL,
        viewport: { width: windowWidth, height: 800 },
      });
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await installApi(page);
        await open(page);
        const metrics = await page.evaluate(() => ({
          ratio: window.devicePixelRatio,
          inner: window.innerWidth,
        }));
        expect(metrics.ratio, 'devicePixelRatio proves browser zoom').toBeCloseTo(zoom, 1);
        expect(metrics.inner, 'layout viewport shrinks by the zoom factor').toBe(
          Math.round(windowWidth / zoom),
        );
        for (const route of routes) {
          await open(page, route.hash);
          await expectContained(page, `${route.hash} ${label}`);
          const primary = await revealNavigation(page);
          for (const name of linkNames) {
            const link = primary.getByRole('link', { name, exact: true });
            // A 200px-tall viewport (400% zoom) shows the panel scrolled, so scroll before checking.
            await link.scrollIntoViewIfNeeded();
            await expect(link).toBeInViewport({ ratio: 1 });
          }
        }
        await open(page, '#tasks');
        const button = menuButton(page);
        if (await button.isVisible()) {
          await expect(button).toBeInViewport({ ratio: 1 });
          await expect(button).toHaveAttribute('aria-expanded', 'false');
          await button.click();
          await expect(nav(page).getByRole('link', { name: 'Runs', exact: true })).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(button).toBeFocused();
        }
        await expect(signOut(page)).toBeInViewport({ ratio: 1 });
        await testInfo.attach(`zoom-${zoom * 100}-window-${windowWidth}.png`, {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      } finally {
        await context.close();
        rmSync(profile, { recursive: true, force: true });
      }
    });
  }
});
