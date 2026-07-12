// Host connection banner — display-only. The host client (host-store.ts)
// already reconnects with backoff on its own; this just surfaces the
// connection state so a dropped (or not-yet-established) connection doesn't
// read as the app silently going stale (see docs/FRONTEND.md house rule: no
// pulsing liveness dots — the banner itself is the whole affordance, no
// spinner needed).

import { useHostStatus } from "@/lib/board/useBoard";
import { cn } from "@/lib/utils";

export function ConnectionBanner() {
  const status = useHostStatus();

  // Connected ⇒ nothing to say. Hidden ⇒ non-interactive (house rule 4), and
  // unmounted rather than faded: there's nothing inside to keep focusable,
  // and a banner that isn't shown shouldn't reserve layout space above the
  // content pane.
  if (status === "connected") return null;

  const connecting = status === "connecting";

  return (
    <div
      role="status"
      className={cn(
        "shrink-0 border-b px-4 py-1.5 text-[13px]",
        connecting
          ? "border-border bg-muted/40 text-muted-foreground"
          : "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {connecting
        ? "Connecting to the Elan host…"
        : "Can't reach the Elan host — retrying. Start one with `bun dev/elan-host.ts`, or relaunch the desktop app."}
    </div>
  );
}
