// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The gate's whole setup in one reviewable file: the mode it ships with, the
 * model and endpoint it calls, the policy numbers, and the four questions.
 * Nothing else hard-codes a gate value — the policy, the run's failure limit,
 * the setting's default, and the harness all read them from here — so any
 * change to this file changes the policy hash.
 */

import type { GateMode } from "./gate.js";
import type { JevQuestion, QuestionId } from "./jev.js";

const QUESTION_PREFIX = "In this exchange between a user and an AI coding agent, ";

/** Every value the gate's behavior depends on, each decided by the comment above it. */
interface GateConfig {
  /** The mode used when neither the --gate-mode flag nor the setting selects one. */
  defaultMode: GateMode;
  /** The modes the --gate-mode flag accepts. */
  modes: readonly GateMode[];
  /** The classifier release every gate request is pinned to. */
  model: string;
  /** Where every gate request is sent. */
  endpoint: string;
  /** All four answers at or below it mean the trio carries no lesson. */
  threshold: number;
  /** A bigger UTF-8 JSON state falls back without a request. */
  stateCapBytes: number;
  /** Total time one gate call may take, every attempt and wait included. */
  deadlineMs: number;
  /** Wait before the single retry when the response carries no Retry-After. */
  defaultRetryWaitMs: number;
  /** Consecutive request failures after which the gate is off for the rest of the run. */
  failureLimit: number;
  /** The four questions sent with every request; their ids key the answers. */
  questions: Record<QuestionId, JevQuestion>;
}

export const GATE_CONFIG: GateConfig = {
  defaultMode: "off",
  modes: ["off", "shadow", "enforce"],
  model: "jev-1.13.0",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  threshold: 0.1,
  stateCapBytes: 32 * 1024,
  deadlineMs: 5000,
  defaultRetryWaitMs: 500,
  failureLimit: 3,
  questions: {
    correction: {
      type: "noul",
      instructions: `${QUESTION_PREFIX}does the user's reply correct or push back on something the agent said or did?`,
      criteria: {
        true: "The user says the agent got something wrong (code, a claim, an assumption), missed something, or did something the user did not want.",
        false:
          "The user accepts the work, moves on, or asks something new without saying the agent got anything wrong.",
      },
    },
    preference: {
      type: "noul",
      instructions: `${QUESTION_PREFIX}does the user's reply say how they want the agent to work or communicate with them?`,
      criteria: {
        true: "The user states a preference that could apply again later: how long or detailed answers should be, when to ask before acting, how much to change at once, which tools or style to use.",
        false: "The user only says what to do in this task (what to build, fix, or explain).",
      },
    },
    steering: {
      type: "noul",
      instructions: `${QUESTION_PREFIX}does the user's reply change how the agent is going about the task?`,
      criteria: {
        true: "The user asks for a different method, a different order of steps, planning first, a narrower or wider scope, or a rethought decision.",
        false: "The user lets the agent carry on, or only adds task details.",
      },
    },
    confusion: {
      type: "noul",
      instructions: `${QUESTION_PREFIX}does the user's reply show they had trouble following the agent?`,
      criteria: {
        true: "The user says they are lost or confused, cannot tell what changed or what to do next, or asks for a summary, clarification, or a slower pace.",
        false: "The user follows what the agent did and said without trouble.",
      },
    },
  },
};

/** Freeze the config and everything inside it, so no caller can mutate what the hash covers. */
function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  Object.freeze(value);
}

deepFreeze(GATE_CONFIG);
