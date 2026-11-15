// Temporary #302 diagnostic: why the Pixi scene does not start in CI Firefox.
const { test } = require('@playwright/test');
const { startDive } = require('./helpers/start-dive.cjs');

test('c302 diagnostic', async ({ page }) => {
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto('/dist/');
  console.log('WEBGL', await page.evaluate(() => {
    const out = {};
    for (const kind of ['webgl2', 'webgl']) {
      const g = document.createElement('canvas').getContext(kind);
      const info = g && g.getExtension('WEBGL_debug_renderer_info');
      out[kind] = g ? `${g.getParameter(g.VERSION)} / ${info ? g.getParameter(info.UNMASKED_RENDERER_WEBGL) : '?'}` : 'none';
    }
    out.gpu = typeof navigator.gpu;
    return JSON.stringify(out);
  }));
  await startDive(page);
  test.setTimeout(150000);
  for (let t = 0; t <= 90; t += 5) {
    console.log('T', t, await page.locator('[data-renderer=pixi] canvas').count(), await page.locator('[data-renderer]').evaluateAll((els) => els.map((e) => e.getAttribute('data-renderer') + ':' + e.childElementCount).join(',')));
    await page.waitForTimeout(5000);
  }
  console.log('CANVAS', await page.locator('[data-renderer=pixi] canvas').count());
  console.log('BODY', (await page.locator('body').innerText()).slice(0, 600));
});
