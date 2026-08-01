const { expect, test } = require('@playwright/test');

test('planner Worker runs off-main-thread from a same-origin module', async ({ page }) => {
  const workerUrl = new Promise(resolve => {
    page.once('worker', worker => resolve(worker.url()));
  });

  await page.goto('/dist/');
  const url = await workerUrl;
  const forecast = await page.evaluate(() => window.plannerWorkerDiagnostic);

  expect(url).toMatch(
    /^http:\/\/127\.0\.0\.1:8080\/dist\/assets\/planner-worker-/,
  );
  expect(url).not.toMatch(/^blob:/);
  expect(forecast).toMatchObject({
    ceilingM: 0,
    ndlMin: 999,
    schedule: null,
    ttsMin: 0,
  });
});
