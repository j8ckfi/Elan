// The composer's circular send control — a three-state machine:
//   • disabled (no content)                  → muted grey circle
//   • active   (has content)                 → solid foreground circle + arrow
//   • stop     (agent working, empty draft)  → solid circle with a stop square
//
// No liquid-metal shader, no beam — a plain, calm control that matches the
// blank-slate feel of the rest of the app.

import { useIcon } from "@/lib/icon-context";
import { cn } from "@/lib/utils";

export type SendMode = "send" | "queue" | "stop";

interface SendButtonProps {
  mode: SendMode;
  canSend: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}

const BASE =
  "relative flex h-9 w-9 items-center justify-center rounded-full outline-none " +
  "transition-[transform,background-color,color] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)] " +
  "active:scale-[0.96] focus-visible:ring-2 focus-visible:ring-ring/70 " +
  "disabled:cursor-default";

export function SendButton({
  mode,
  canSend,
  disabled,
  label,
  onClick,
}: SendButtonProps) {
  const ArrowUp = useIcon("arrow-up");

  // Stop: agent working with an empty draft.
  if (mode === "stop") {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        className={cn(BASE, "bg-foreground/90 text-background hover:bg-foreground")}
      >
        <span className="h-3 w-3 rounded-[3px] bg-current" />
      </button>
    );
  }

  // Nothing to send yet → muted, disabled.
  if (!canSend) {
    return (
      <button
        type="button"
        aria-label={label}
        disabled
        className={cn(BASE, "bg-muted text-muted-foreground/50")}
      >
        <ArrowUp size={18} className="block" />
      </button>
    );
  }

  // Content present → solid, ready.
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        BASE,
        "bg-foreground text-background hover:bg-foreground/90",
      )}
    >
      <ArrowUp size={18} strokeWidth={2.4} className="block" />
    </button>
  );
}
