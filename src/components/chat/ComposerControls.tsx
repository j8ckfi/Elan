// The little pills on the left of the chat bar: model picker + thinking effort.
// Rendered inside InputMessage's leftSlot. Both use Fluid's Select (Base UI).

import { Fragment, useMemo } from "react";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectLabel,
} from "@/components/ui/select";
import { ContextRing } from "@/components/chat/ContextRing";
import { cn } from "@/lib/utils";
import type { Model, SessionStats, ThinkingLevel } from "@/lib/pi/types";
import {
  supportedThinkingLevels,
  hasThinkingChoice,
  THINKING_LABELS,
} from "@/lib/pi/thinking";

const PILL =
  "h-7 min-w-0 gap-1 rounded-full px-2.5 text-[12px] text-muted-foreground " +
  "transition-[transform,color,background-color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] " +
  "hover:bg-hover hover:text-foreground active:scale-[0.96]";

export function ComposerControls({
  model,
  availableModels,
  thinkingLevel,
  stats,
  onSelectModel,
  onSelectThinking,
}: {
  model: Model | null;
  availableModels: Model[];
  thinkingLevel: ThinkingLevel | null;
  stats: SessionStats | null;
  onSelectModel: (provider: string, modelId: string) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
}) {
  // Flatten into a globally-indexed list (Select registers items by index),
  // marking each provider's first entry so we can insert a group label.
  const modelItems = useMemo(() => {
    const map = new Map<string, Model[]>();
    for (const m of availableModels) {
      const arr = map.get(m.provider) ?? [];
      arr.push(m);
      map.set(m.provider, arr);
    }
    const out: {
      provider: string;
      model: Model;
      index: number;
      firstOfProvider: boolean;
    }[] = [];
    let index = 0;
    for (const [provider, models] of map) {
      models.forEach((model, j) => {
        out.push({ provider, model, index, firstOfProvider: j === 0 });
        index += 1;
      });
    }
    return out;
  }, [availableModels]);

  const modelValue = model ? `${model.provider}/${model.id}` : undefined;

  // Read the levels this specific model accepts, in strength order. The picker
  // only appears when there's a genuine choice — non-reasoning models (and any
  // model with a single forced level) show nothing.
  const thinkingLevels = supportedThinkingLevels(model);
  const showThinking = hasThinkingChoice(model);

  return (
    <div className="flex items-center gap-1">
      {/* Context-window ring — sits just left of the model it measures. */}
      <ContextRing stats={stats} model={model} />

      {/* Model pill */}
      <Select
        value={modelValue}
        onValueChange={(v) => {
          const i = v.indexOf("/");
          if (i > 0) onSelectModel(v.slice(0, i), v.slice(i + 1));
        }}
      >
        <SelectTrigger
          variant="borderless"
          placeholder="Model"
          className={PILL}
        />
        <SelectContent className="max-h-[60vh] min-w-[240px]">
          {modelItems.map(({ provider, model: m, index, firstOfProvider }) => (
            <Fragment key={`${provider}/${m.id}`}>
              {firstOfProvider && (
                <SelectLabel className="text-[11px] uppercase tracking-wide">
                  {provider}
                </SelectLabel>
              )}
              <SelectItem value={`${provider}/${m.id}`} index={index}>
                {m.name || m.id}
              </SelectItem>
            </Fragment>
          ))}
        </SelectContent>
      </Select>

      {/* Thinking pill — only when the model offers a real choice of levels,
          and only the levels it actually accepts (read from the model, never
          hard-coded). */}
      {showThinking && (
        <Select
          value={thinkingLevel ?? undefined}
          onValueChange={(v) => onSelectThinking(v as ThinkingLevel)}
        >
          <SelectTrigger
            variant="borderless"
            placeholder="Thinking"
            className={cn(PILL, "min-w-0")}
          />
          <SelectContent className="min-w-[160px]">
            {thinkingLevels.map((level, i) => (
              <SelectItem key={level} value={level} index={i}>
                {THINKING_LABELS[level]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
