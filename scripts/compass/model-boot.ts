// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * Model setup shared by the harness's run paths: the runtime read from the
 * operator's pi config (read only), the model resolution with its two access
 * blockers, the settings getter the LLM calls read, the counter-wrapped
 * default stream function, and the captured model. The caller keeps its own
 * attempt sink, receipts, and error reporting.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { PortraitSettings } from "../../src/schema.js";
import type { RequestCounter } from "./counter.js";
import { strings } from "./strings.js";

/** The settings snapshot as the run paths read it (portrait settings plus the host defaults). */
export interface ModelSnapshot {
  portraitSettings: PortraitSettings;
  hostPiSettings: { defaultProvider?: string; defaultModel?: string };
}

/** The resolved portrait model for one run. */
interface BootedModel {
  model: { provider: string; id: string };
}

/**
 * Boot the model for one run: resolve the portrait model (or the host default),
 * install the settings getter the LLM calls read, and install the
 * counter-wrapped stream function as the request path. Returns the existing
 * access-blocker message instead of the model when nothing is resolvable.
 */
export async function bootModel(
  snapshot: ModelSnapshot,
  counter: RequestCounter,
): Promise<BootedModel | { error: string }> {
  // Model runtime from the operator's pi config (auth.json/models.json) — read only.
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  const { setDefaultStreamFn } = await import("@earendil-works/pi-agent-core");
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const registry = new ModelRegistry(runtime);

  // Resolve the portrait model; record access blockers, never credentials.
  const settingsUi = await import("../../src/settings-ui.js");
  settingsUi._setGetPortraitSettings(() => ({ ...snapshot.portraitSettings }));
  const modelString: string | null = snapshot.portraitSettings.model ?? null;
  let model: { provider: string; id: string };
  if (modelString) {
    const slash = modelString.indexOf("/");
    const found = slash > 0 ? registry.find(modelString.slice(0, slash), modelString.slice(slash + 1)) : undefined;
    if (!found) return { error: strings.modelUnavailable(modelString) };
    model = found;
  } else {
    // No override configured — use the operator's default model.
    const host = snapshot.hostPiSettings;
    const found =
      host.defaultProvider && host.defaultModel ? registry.find(host.defaultProvider, host.defaultModel) : undefined;
    if (!found) return { error: strings.noModelOverride };
    model = found;
  }

  // Install the counter at the usable request hook: the wrapped default streamFn.
  const wrapped = counter.wrapStreamFn((m: unknown, ctx: unknown, options: unknown) =>
    registry.streamSimple(
      m as Parameters<typeof registry.streamSimple>[0],
      ctx as Parameters<typeof registry.streamSimple>[1],
      options as Parameters<typeof registry.streamSimple>[2],
    ),
  );
  setDefaultStreamFn(wrapped as never);

  const llmCall = await import("../../src/llm-call.js");
  llmCall.setCapturedModel(model as never, registry as never);
  return { model };
}
