const { expect, test } = require('@playwright/test');

test('wreck slice requires the simulation-use boundary before WebGL starts', async ({ page }) => {
  await page.goto('/dist/');

  await expect(
    page.getByRole('heading', {
      name: 'This is a simulation, not a dive planner',
    }),
  ).toBeVisible();
  await expect(page.locator('[data-wreck-viewport]')).toHaveCount(0);
  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'I understand — start simulation',
    }),
  ).toBeVisible();
});

test('production starts the Pixi wreck shell with semantic HUD and controls', async ({ page }) => {
  await page.goto('/dist/?renderer=canvas');
  await page
    .getByRole('button', { name: 'I understand — start simulation' })
    .click();

  const viewport = page.locator('[data-wreck-viewport]');
  await expect(viewport).toHaveAttribute('data-renderer', 'pixi');
  await expect(viewport.locator('canvas')).toBeVisible();
  await expect(page.getByText('Simulation running')).toBeVisible();
  await expect(page.getByText('Wreck exterior')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle torch' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Mute audio' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Mute audio' }).click();
  await expect(page.getByRole('button', { name: 'Mute audio' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Toggle torch' }).click();
  await expect(page.getByRole('button', { name: 'Toggle torch' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  const depthValue = page.locator('.wreck-hud dd').first();
  const initialDepth = await depthValue.textContent();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(1250);
  await page.keyboard.up('ArrowDown');
  await expect(depthValue).not.toHaveText(initialDepth || '');
  await expect(page.locator('[role="alert"]')).toBeHidden();

  const savedDepth = await depthValue.textContent();
  await page.reload();
  await page
    .getByRole('button', { name: 'I understand — start simulation' })
    .click();
  await expect(page.locator('.wreck-hud dd').first()).toHaveText(savedDepth || '');
});

test('persisted safety states produce visible semantic warnings', async ({ page }) => {
  await page.goto('/dist/');
  await page
    .getByRole('button', { name: 'I understand — start simulation' })
    .click();
  await page.locator('[data-renderer=pixi] canvas').waitFor();
  await page.reload();

  await mutateSavedState(page, 'low-gas');
  await page
    .getByRole('button', { name: 'I understand — start simulation' })
    .click();
  await expect(page.getByRole('alert')).toHaveText(
    'Low gas pressure — begin a controlled exit',
  );
  await page.reload();

  await mutateSavedState(page, 'oxygen');
  await page
    .getByRole('button', { name: 'I understand — start simulation' })
    .click();
  await expect(page.getByRole('alert')).toHaveText(
    'Unsafe simulated oxygen pressure',
  );
  await page.reload();

  await mutateSavedState(page, 'failure');
  await page
    .getByRole('button', { name: 'I understand — start simulation' })
    .click();
  await expect(page.getByRole('alert')).toHaveText(
    'Simulated dive failure — return to the surface',
  );
});

async function mutateSavedState(page, variant) {
  await page.evaluate(selectedVariant => {
    const key = 'diving-simulator.save-game';
    const raw = localStorage.getItem(key);
    if (!raw) throw new Error('expected the wreck save to exist');
    const save = JSON.parse(raw);
    const tank = save.state.tanks[save.state.activeTankIndex];

    if (selectedVariant === 'low-gas') {
      tank.gasRemainingL = tank.volumeL * 40;
    } else if (selectedVariant === 'oxygen') {
      tank.gas.oxygenFraction = 1;
      tank.gas.heliumFraction = 0;
      tank.gas.nitrogenFraction = 0;
    } else if (selectedVariant === 'failure') {
      save.state.failure.reason = 'out-of-gas';
      save.state.events.push({
        type: 'failure',
        elapsedTimeS: save.state.elapsedTimeS,
        failureReason: 'out-of-gas',
      });
    }
    localStorage.setItem(key, JSON.stringify(save));
  }, variant);
}
