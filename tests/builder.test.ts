// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * buildPortrait's validation loop tags each call with validationRound=1 on the
 * first try and +1 after every failed validation, all stage "building".
 * llm-call is mocked centrally, so this observes the arguments
 * that produce the attempt events.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type vi } from "vitest";
import { buildPortrait } from "../src/builder.js";
import { callPortraitLlm } from "../src/llm-call.js";
import { setupTestSettings, teardownTestSettings } from "./settings-helpers.js";

const mockCallPortraitLlm = callPortraitLlm as unknown as ReturnType<typeof vi.fn>;

let portraitDir: string;

function writeTestPortrait(dir: string, rules: string[]): void {
  const content = `# User Portrait\n\n## Anticipation Rules\n${rules.join("\n")}\n`;
  fs.writeFileSync(path.join(dir, "portrait.md"), content, "utf-8");
}

beforeEach(() => {
  mockCallPortraitLlm.mockReset();
  portraitDir = path.join(os.tmpdir(), `portrait-builder-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(portraitDir, { recursive: true });
  setupTestSettings(null);
});

afterEach(() => {
  teardownTestSettings();
  fs.rmSync(portraitDir, { recursive: true, force: true });
});

describe("buildPortrait validationRound", () => {
  it("tags a failed validation then a passed one as building rounds 1 then 2", async () => {
    writeTestPortrait(portraitDir, ["rule 1"]);
    mockCallPortraitLlm
      .mockResolvedValueOnce({ decisions: [{ action: "merge", candidate: "candidate one" }] }) // invalid: no mergePosition
      .mockResolvedValueOnce({ decisions: [{ action: "skip", candidate: "candidate one" }] });

    const result = await buildPortrait(portraitDir, ["candidate one"], undefined);

    expect(result).toBeDefined();
    expect(mockCallPortraitLlm).toHaveBeenCalledTimes(2);
    const stages = mockCallPortraitLlm.mock.calls.map((call) => call[8]);
    const rounds = mockCallPortraitLlm.mock.calls.map((call) => call[9]);
    expect(stages).toEqual(["building", "building"]);
    expect(rounds).toEqual([1, 2]);
  });
});
