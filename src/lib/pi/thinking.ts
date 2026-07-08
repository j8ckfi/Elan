// Model-aware thinking levels.
//
// Pi exposes each model's supported reasoning levels through `Model.reasoning`
// (does it think at all?) and `Model.thinkingLevelMap` (which of the six pi
// levels the provider actually accepts). We must NOT hard-code a fixed list of
// levels — GLM-5.2 offers only High + Max, gpt-5.5 drops the low tiers, and
// non-reasoning models have none at all. This mirrors pi-ai's own
// `getSupportedThinkingLevels` so the picker always matches the model.

import type { Model, ThinkingLevel } from "./types";

// Ordered weakest → strongest; the picker renders in this order.
const ORDER: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

/** The thinking levels a given model actually accepts.
 *
 *  Rules (verbatim from pi-ai `getSupportedThinkingLevels`):
 *   • a non-reasoning model supports only `off`;
 *   • a level mapped to `null` is explicitly unsupported;
 *   • `xhigh` counts only when the model lists it (map value !== undefined) —
 *     it's the codex/GLM "max" tier, off by default;
 *   • every other level (including ones absent from the map) is supported,
 *     falling back to the provider default. */
export function supportedThinkingLevels(model: Model | null): ThinkingLevel[] {
  if (!model || !model.reasoning) return ["off"];
  return ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

/** True when the model gives the user a real choice of thinking level. A model
 *  with one forced level (or none — just `off`) shows no picker. */
export function hasThinkingChoice(model: Model | null): boolean {
  return supportedThinkingLevels(model).length > 1;
}

// Display labels for the picker. `xhigh` reads as "Max" — it's the top tier and
// what providers like GLM/codex literally call it.
export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
};
