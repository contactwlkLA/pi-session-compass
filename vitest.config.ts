// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/compass/**"],
    isolate: false,
    testTimeout: 30_000,
    setupFiles: ["./tests/setup.ts"],
  },
});
