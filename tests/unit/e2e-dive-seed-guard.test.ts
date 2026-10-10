import { describe, expect, it } from "vitest";

// Every e2e spec that opens the migration client (/dist/) goes through
// tests/helpers/pinned-seed.cjs (#219 part 2). A dive draws its own seed at
// its start, so a spec on the platform's draws would roll for a shark on a
// new seed every run and, once in a while, meet one.

const SPECS = import.meta.glob("../*.spec.js", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

const OPENS_MIGRATION_CLIENT = /\.goto\(\s*['"`]\/dist\//;
const USES_PINNED_SEED = /require\(\s*['"]\.\/helpers\/pinned-seed\.cjs['"]\s*\)/;
const USES_PLAYWRIGHT_DIRECTLY = /require\(\s*['"]@playwright\/test['"]\s*\)/;

describe("the e2e specs of the migration client", () => {
  it("are found", () => {
    const migration = Object.entries(SPECS).filter(([, source]) => OPENS_MIGRATION_CLIENT.test(source));
    expect(migration.length).toBeGreaterThan(5);
  });

  it("all pin the dive's seed", () => {
    const unpinned = Object.entries(SPECS)
      .filter(([, source]) => OPENS_MIGRATION_CLIENT.test(source))
      .filter(([, source]) => !USES_PINNED_SEED.test(source) || USES_PLAYWRIGHT_DIRECTLY.test(source))
      .map(([file]) => file);
    expect(unpinned).toEqual([]);
  });
});
