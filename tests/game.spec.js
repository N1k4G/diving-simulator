const { test, expect } = require('@playwright/test');

test.setTimeout(180000);
test('all game tests pass', async ({ page }) => {
  // Capture browser console errors. One is not the client's: headless
  // Chrome blocks navigator.vibrate() until the user has tapped the page,
  // and logs that intervention as an error. playAlertBeep() vibrates whenever
  // the HUD draws a warning, and the harness page keeps drawing between test
  // cases, so whether one lands depends on timing (#194). Only that exact
  // intervention is ignored; any other error still fails the test.
  const VIBRATE_INTERVENTION = /^Blocked call to navigator\.vibrate because user hasn't tapped on the frame or any embedded frame yet/;
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error' && !VIBRATE_INTERVENTION.test(msg.text())) consoleErrors.push(msg.text());
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
