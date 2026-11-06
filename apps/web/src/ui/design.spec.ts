import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';

/**
 * Browser tests for the OMNIS NEXUS design system, run against its development-only showcase at
 * /design-system.html. The showcase uses sample content and makes no API calls.
 */

const SHOWCASE = '/design-system.html';

async function open(page: Page) {
  await page.goto(SHOWCASE);
  await expect(
    page.getByRole('heading', { level: 1, name: 'OMNIS NEXUS design system' }),
  ).toBeVisible();
}

// ---- WCAG contrast helpers, computed from the colours the browser actually resolves ----------

type Rgb = [number, number, number, number];
function parse(color: string): Rgb {
  const m = /rgba?\(([^)]+)\)/.exec(color) ?? /color\(srgb ([^)]+)\)/.exec(color);
  if (!m?.[1]) throw new Error(`Unparseable colour: ${color}`);
  const parts = m[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  const scale = color.startsWith('color(') ? 255 : 1;
  return [parts[0]! * scale, parts[1]! * scale, parts[2]! * scale, parts[3] ?? 1];
}
function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Resolved text colour, nearest opaque background, and border colour of the first match. */
async function colours(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const cs = getComputedStyle(el);
      let node: Element | null = el;
      let background = 'rgb(6, 12, 14)';
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          background = bg;
          break;
        }
        node = node.parentElement;
      }
      let page = 'rgb(6, 12, 14)';
      const root = document.querySelector('.nx-theme');
      if (root) page = getComputedStyle(root).backgroundColor;
      return {
        color: cs.color,
        background,
        border: cs.borderTopColor,
        page,
        outline: cs.outlineColor,
      };
    });
}

test.describe('tokens and contrast', () => {
  test('text roles meet 4.5:1 on the surfaces they are used on', async ({ page }) => {
    await open(page);
    const textSelectors = [
      '.nx-page-header h1',
      '.nx-label',
      '.nx-muted',
      '.nx-field__hint',
      '.nx-table th',
      '.nx-table td',
      '.nx-button[data-variant="secondary"]',
      '.nx-button[data-variant="primary"]',
      '.nx-button[data-variant="danger"]',
      '.nx-input',
      '.nx-status[data-tone="ok"]',
      '.nx-status[data-tone="attention"]',
      '.nx-status[data-tone="danger"]',
      '.nx-status[data-tone="info"]',
      '.nx-status[data-tone="neutral"]',
      '.nx-status[data-tone="unknown"]',
    ];
    for (const selector of textSelectors) {
      const c = await colours(page, selector);
      expect(
        ratio(parse(c.color), parse(c.background)),
        `${selector} text contrast`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    // Validation text only exists after a failed submit.
    await page.getByRole('button', { name: 'Validate' }).click();
    const error = await colours(page, '.nx-field__error');
    expect(ratio(parse(error.color), parse(error.background))).toBeGreaterThanOrEqual(4.5);
  });

  test('control boundaries meet 3:1 against the page', async ({ page }) => {
    await open(page);
    for (const selector of ['.nx-input', '.nx-button[data-variant="secondary"]']) {
      const c = await colours(page, selector);
      expect(ratio(parse(c.border), parse(c.page)), `${selector} border`).toBeGreaterThanOrEqual(3);
    }
  });

  test('keyboard focus ring meets 3:1 on both page and panel surfaces', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Secondary' }).focus();
    const c = await colours(page, '.nx-button:focus-visible');
    const outline = parse(c.outline);
    expect(ratio(outline, parse(c.page))).toBeGreaterThanOrEqual(3);
    expect(ratio(outline, parse(await panelBackground(page)))).toBeGreaterThanOrEqual(3);
  });

  test('status meaning does not rely on colour: every badge has text and tones differ in shape', async ({
    page,
  }) => {
    await open(page);
    const badges = page.locator('.nx-status');
    const count = await badges.count();
    expect(count).toBeGreaterThan(5);
    for (let i = 0; i < count; i += 1) {
      expect((await badges.nth(i).innerText()).trim().length).toBeGreaterThan(0);
    }
    const shapes = await page.evaluate(() => {
      const tone = (name: string) => {
        const el = document.querySelector(`.nx-status[data-tone="${name}"]`)!;
        const before = getComputedStyle(el, '::before');
        return `${before.borderRadius}|${before.clipPath}|${before.transform}|${before.backgroundColor}`;
      };
      return ['ok', 'attention', 'danger', 'unknown'].map(tone);
    });
    expect(new Set(shapes).size, 'ok, attention, danger and unknown render distinct shapes').toBe(
      4,
    );
  });

  test('fonts are system fallbacks and no font or stylesheet comes from another origin', async ({
    page,
  }) => {
    const external: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname !== '127.0.0.1') external.push(request.url());
    });
    await open(page);
    expect(external).toEqual([]);
    const families = await page.evaluate(() => [
      getComputedStyle(document.querySelector('.nx-theme')!).fontFamily,
      getComputedStyle(document.querySelector('.nx-label')!).fontFamily,
    ]);
    expect(families[0]).toContain('system-ui');
    expect(families[1]).toContain('monospace');
  });

  test('the main application does not load the design system', async ({ page }) => {
    await page.goto('/');
    const token = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--nx-jade').trim(),
    );
    expect(token, 'tokens must not leak into the existing application').toBe('');
  });
});

async function panelBackground(page: Page): Promise<string> {
  return page
    .locator('.nx-panel')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
}

test.describe('responsive containment', () => {
  const widths = [320, 390, 720, 820, 1024, 1440];
  for (const width of widths) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(metrics.doc).toBeLessThanOrEqual(metrics.client);
      // Wide tables scroll inside their own region, never the page.
      const wrap = page.locator('.nx-table-wrap');
      const box = await wrap.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await test.info().attach(`design-${width}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });
  }

  test('a 16px minimum font setting still contains the page at 320px', async () => {
    const browser = await chromium.launch({ args: ['--blink-settings=minimumFontSize=16'] });
    try {
      const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
      await page.goto(`http://127.0.0.1:5173${SHOWCASE}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const m = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(m.doc).toBeLessThanOrEqual(m.client);
    } finally {
      await browser.close();
    }
  });

  test('genuine 200% browser zoom reflows without overflow', async () => {
    const baseURL = test.info().project.use.baseURL;
    if (!baseURL) throw new Error('The Playwright project has no baseURL.');
    const level = Math.log(2) / Math.log(1.2); // Chromium's zoom level for 200%
    const profile = mkdtempSync(join(tmpdir(), 'omnis-ds-zoom-'));
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
      viewport: { width: 1280, height: 800 },
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await open(page);
      const m = await page.evaluate(() => ({
        ratio: window.devicePixelRatio,
        inner: window.innerWidth,
        doc: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(m.ratio, 'devicePixelRatio proves real browser zoom').toBeCloseTo(2, 1);
      expect(m.inner).toBe(640);
      expect(m.doc).toBeLessThanOrEqual(m.client);
      await expect(page.getByRole('button', { name: 'Primary action' })).toBeInViewport({
        ratio: 1,
      });
    } finally {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
});

test.describe('accessibility', () => {
  for (const width of [390, 1440]) {
    test(`axe finds no violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await open(page);
      await page.getByRole('button', { name: 'Validate' }).click(); // include the error state
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test('axe finds no violations with the confirmation dialog open', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Delete sample record…' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete sample record?' })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });

  test('every interactive control shows a visible focus ring when reached by Tab', async ({
    page,
  }) => {
    await open(page);
    const seen: string[] = [];
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          name: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? el.tagName,
          width: parseFloat(cs.outlineWidth),
          style: cs.outlineStyle,
        };
      });
      if (!info) break;
      seen.push(info.name);
      expect(info.style, `${info.name} outline style`).not.toBe('none');
      expect(info.width, `${info.name} outline width`).toBeGreaterThanOrEqual(2);
    }
    expect(seen.length).toBeGreaterThan(8);
  });

  test('the scrollable table region is reachable and labelled', async ({ page }) => {
    await open(page);
    const region = page.getByRole('region', { name: 'Sample records' });
    await region.focus();
    await expect(region).toBeFocused();
    await expect(page.getByRole('table', { name: 'Sample records' })).toBeVisible();
  });
});

test.describe('behaviour', () => {
  test('a field links its label, hint and error, and flags invalid state', async ({ page }) => {
    await open(page);
    const input = page.getByLabel('Name');
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Enter a name.' })).toBeVisible();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(/Shown to operators\..*Enter a name\./);
    await input.fill('Ada');
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Enter a name.')).toHaveCount(0);
  });

  test('a busy button stays focusable and ignores repeated clicks', async ({ page }) => {
    await open(page);
    const start = page.getByRole('button', { name: 'Start (sample)' });
    await start.click();
    const working = page.getByRole('button', { name: 'Working…' });
    await expect(working).toHaveAttribute('aria-busy', 'true');
    // aria-disabled, not the disabled attribute: a disabled button would drop out of the tab order.
    await expect(working).not.toHaveAttribute('disabled');
    await working.focus();
    await expect(working).toBeFocused();
    await expect(page.getByRole('button', { name: 'Start (sample)' })).toBeVisible({
      timeout: 4000,
    });
  });

  test('the filter narrows the table and falls back to an empty state', async ({ page }) => {
    await open(page);
    const table = page.getByRole('table', { name: 'Sample records' });
    await expect(table.getByRole('row')).toHaveCount(5); // header + 4
    await page.getByLabel('Filter sample records').fill('record b');
    await expect(table.getByRole('row')).toHaveCount(2);
    await page.getByLabel('Filter sample records').fill('zzz');
    await expect(page.getByText('No matching records')).toBeVisible();
    await expect(table).toHaveCount(0);
  });

  test('the confirmation dialog defaults to Cancel, traps focus, closes on Escape and restores focus', async ({
    page,
  }) => {
    await open(page);
    const opener = page.getByRole('button', { name: 'Delete sample record…' });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Delete sample record?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    // The background is inert: Tab may reach the dialog's own controls or leave the page to the
    // browser (activeElement is then the body), but it never lands on a background control.
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return 'browser';
        return el.closest('dialog') ? 'dialog' : 'background';
      });
      expect(where).not.toBe('background');
    }
    await page.getByRole('button', { name: 'Cancel' }).focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(page.getByText('Confirmed (sample')).toHaveCount(0);
    // Confirming takes effect.
    await opener.click();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Confirmed (sample; nothing was deleted).')).toBeVisible();
  });

  test('reduced motion removes the spinner animation and control transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await page.getByRole('button', { name: 'Start (sample)' }).click();
    const styles = await page.evaluate(() => {
      const spinner = document.querySelector('.nx-button .nx-spinner')!;
      const button = document.querySelector('.nx-button')!;
      return {
        animation: getComputedStyle(spinner).animationName,
        transition: getComputedStyle(button).transitionDuration,
      };
    });
    expect(styles.animation).toBe('none');
    expect(styles.transition).toBe('0s');
  });

  test('without reduced motion the loading spinner does animate', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open(page);
    const name = await page
      .locator('.nx-state .nx-spinner')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName);
    expect(name).toBe('nx-spin');
  });
});
