// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The collection's fixed values in one reviewable file: scan size, lock
 * polling, retry backoff, and footer refresh. Nothing else hard-codes these
 * values — the pipeline loop, the lock poll, the LLM retry, and the status
 * footer read them from here, and /portrait:config shows them with the settings.
 * Changing a value here changes what every consumer does; no policy hash
 * depends on this file.
 */

/** Every collection value that is not a setting, each with what it controls. */
interface PluginConfig {
  /** Session files one scan step reads before it returns. */
  filesPerScan: number;
  /** How often an instance without the lock checks whether it can take it. */
  lockPollMs: number;
  /** Wait before the first retry of a failed LLM call; doubles per attempt. */
  retryBackoffBaseMs: number;
  /** Upper bound for the doubling retry wait. */
  retryBackoffCapMs: number;
  /** How often the status footer updates. */
  footerRefreshMs: number;
}

export const PLUGIN_CONFIG: PluginConfig = {
  filesPerScan: 100,
  lockPollMs: 60_000,
  retryBackoffBaseMs: 1_000,
  retryBackoffCapMs: 10_000,
  footerRefreshMs: 5000,
};
