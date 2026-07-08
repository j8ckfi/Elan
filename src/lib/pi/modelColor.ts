// Maps the active model to the Border Beam's color — the one thing in Mari
// that shifts per model.
//
// BorderBeam ships 4 fixed palettes (colorful | mono | ocean | sunset), so
// `colorVariant` alone can only express warm/cool/neutral. The `hue` field
// carries each family's true target hue for the vendored beam (see
// components/ui/BorderBeam) which renders a single-hue palette; until that's
// wired, the wrapper falls back to `colorVariant`.

import type { Model } from "./types";

export type BeamColorVariant = "colorful" | "mono" | "ocean" | "sunset";

export interface BeamColor {
  /** Fluid preset — the coarse fallback. */
  colorVariant: BeamColorVariant;
  /** Target hue in degrees (0=red, 30=orange, 200=cyan, 240=blue…). */
  hue: number;
  /** Human label, for tooltips/debug. */
  label: string;
}

interface Family {
  test: RegExp;
  hue: number;
  colorVariant: BeamColorVariant;
  label: string;
}

// Order matters: first match wins. Test against `provider/id` lowercased.
const FAMILIES: Family[] = [
  { test: /claude|opus|sonnet|haiku|fable|anthropic/, hue: 24, colorVariant: "sunset", label: "Claude" },
  { test: /codex|gpt|openai|o3|o4/, hue: 190, colorVariant: "ocean", label: "OpenAI" },
  { test: /gemini|google/, hue: 225, colorVariant: "ocean", label: "Gemini" },
  { test: /grok|xai/, hue: 210, colorVariant: "mono", label: "Grok" },
  { test: /glm|zhipu|z-?ai/, hue: 2, colorVariant: "sunset", label: "GLM" },
  { test: /kimi|moonshot/, hue: 186, colorVariant: "ocean", label: "Kimi" },
  { test: /qwen|qwq|qwythos|qwopus/, hue: 275, colorVariant: "ocean", label: "Qwen" },
  { test: /deepseek/, hue: 250, colorVariant: "ocean", label: "DeepSeek" },
  { test: /minimax/, hue: 320, colorVariant: "sunset", label: "MiniMax" },
  { test: /composer|cursor/, hue: 150, colorVariant: "ocean", label: "Cursor" },
  { test: /mistral|mixtral|codestral|mellum/, hue: 30, colorVariant: "sunset", label: "Mistral" },
  { test: /llama|nemotron/, hue: 265, colorVariant: "ocean", label: "Llama" },
];

const FALLBACK: BeamColor = { colorVariant: "mono", hue: 220, label: "Model" };

export function modelColor(model: Model | null | undefined): BeamColor {
  if (!model) return FALLBACK;
  const key = `${model.provider ?? ""}/${model.id ?? ""}/${model.name ?? ""}`.toLowerCase();
  const match = FAMILIES.find((f) => f.test.test(key));
  if (!match) return FALLBACK;
  return { colorVariant: match.colorVariant, hue: match.hue, label: match.label };
}
