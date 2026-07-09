// The little pills on the left of the chat bar: model picker + thinking effort.
// The model pill is a searchable combobox (200+ models); the thinking pill is a
// plain Select over the handful of levels the model accepts.

import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { ContextRing } from "@/components/chat/ContextRing";
import { cn } from "@/lib/utils";
import type {
  AgentCapabilities,
  Model,
  SessionStats,
  ThinkingLevel,
} from "@/lib/agent/types";
import {
  supportedThinkingLevels,
  hasThinkingChoice,
  THINKING_LABELS,
} from "@/lib/agent/thinking";

const PILL =
  "h-7 min-w-0 gap-1 rounded-full px-2.5 text-[12px] text-muted-foreground " +
  "transition-[transform,color,background-color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] " +
  "hover:bg-hover hover:text-foreground active:scale-[0.96]";

export function ComposerControls({
  capabilities,
  model,
  availableModels,
  thinkingLevel,
  stats,
  onSelectModel,
  onSelectThinking,
}: {
  /** Backend capabilities — pills for unsupported features don't render. */
  capabilities: AgentCapabilities;
  model: Model | null;
  availableModels: Model[];
  thinkingLevel: ThinkingLevel | null;
  stats: SessionStats | null;
  onSelectModel: (provider: string, modelId: string) => void;
  onSelectThinking: (level: ThinkingLevel) => void;
}) {
  // Read the levels this specific model accepts, in strength order. The picker
  // only appears when there's a genuine choice — non-reasoning models (and any
  // model with a single forced level) show nothing.
  const thinkingLevels = supportedThinkingLevels(model);
  const showThinking = capabilities.thinkingLevels && hasThinkingChoice(model);

  return (
    <div className="flex items-center gap-1">
      {/* Context-window ring — sits just left of the model it measures. */}
      {capabilities.stats && <ContextRing stats={stats} model={model} />}

      {/* Model pill — searchable combobox. */}
      {capabilities.models && (
        <ModelPicker
          model={model}
          availableModels={availableModels}
          onSelectModel={onSelectModel}
          triggerClassName={cn("group", PILL)}
        />
      )}

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
