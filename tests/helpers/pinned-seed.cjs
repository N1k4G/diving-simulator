// Playwright's test, with every dive on a pinned seed (#219 part 2).
//
// A migration dive draws its own seed at its start, from
// crypto.getRandomValues, and the shark's rolls come from it. Left to the
// platform, a spec that runs a dive past a minute would roll for a shark on a
// different seed every run, and once in a while meet one. So the page's
// 32-bit draws are pinned before any script runs: by default to the seed the
// client gave every dive before #219, whose first spawn roll is the 193rd,
// over three hours of dive time in. A spec that wants a shark puts one in its
// save; one that wants another seed sets `diveSeed`.

const base = require('@playwright/test');

/** src/app/game-controller.ts before #219 part 2: no shark for 193 rolls. */
const PINNED_DIVE_SEED = 0x57524543;

function pinDiveSeed(seed) {
  const native = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (array) => {
    if (array instanceof Uint32Array) {
      array.fill(seed);
      return array;
    }
    return native(array);
  };
}

const test = base.test.extend({
  diveSeed: [PINNED_DIVE_SEED, { option: true }],
  page: async ({ page, diveSeed }, use) => {
    await page.addInitScript(pinDiveSeed, diveSeed);
    await use(page);
  },
});

module.exports = { ...base, test, PINNED_DIVE_SEED };
