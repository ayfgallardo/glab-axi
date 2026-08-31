import { configDefaults, defineConfig } from "vitest/config";

// Suites still written against the unported gh-axi modules. Each port lot drops
// its own entry here and from tsconfig's `src/commands` exclusion:
// issue (Task 2), mr (Task 3), ci/schedule (Task 4), snippet/label/release/repo
// (Task 5), variable/stack (Task 6), api/home/setup and help-examples (Task 7).
const NOT_PORTED_YET = [
  "test/commands/**",
  "test/integration/**",
  "test/help-examples.test.ts",
  "test/totals.test.ts",
  "test/suggestions.test.ts",
  "test/gistSelector.test.ts",
];

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...NOT_PORTED_YET],
  },
});
