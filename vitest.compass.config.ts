// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { defineConfig } from "vitest/config";

// Harness suite (tests/compass/**). Run via `npm run test:compass` — it is
// excluded from the default `vitest.config.ts` run.
// Isolation is ON: the compass tests drive the real agentLoop in child
// processes and must not share the upstream suite's stubbed module registry.
// `./tests/setup.ts` is intentionally NOT loaded: compass tests exercise real
// implementations and the setup file's module mocks (config, llm-call,
// storage, collector, …) would replace them with stubs.
export default defineConfig({
  test: {
    include: ["tests/compass/**/*.test.ts"],
    isolate: true,
    testTimeout: 30_000,
  },
});
