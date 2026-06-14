const { test, expect } = require('@playwright/test');

test.setTimeout(180000);
test('all game tests pass', async ({ page }) => {
  // Capture browser console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(err.message));

  await page.goto('/src/diving-simulator-tests.html?autorun');

  // Wait for the test suite to finish (up to 150s — physics sims take time)
  await page.waitForFunction(
    () => window.testResults && window.testResults.done === true,
    { timeout: 150000 }
  );

  const results = await page.evaluate(() => window.testResults);

  // Report each failure clearly
  if (results.failed > 0) {
    const failures = results.tests
      .filter(t => !t.pass)
      .map(t => `  ${t.id} — ${t.name}: ${t.detail || 'assertion failed'}`)
      .join('\n');
    throw new Error(`${results.failed} of ${results.total} tests failed:\n${failures}`);
  }

  expect(results.failed).toBe(0);
  expect(results.passed).toBe(results.total);
  expect(consoleErrors).toHaveLength(0);
});
