// Host-disconnected banner — display-only. The host client (host-store.ts)
// already reconnects with backoff on its own; this just surfaces that state
// so a dropped connection doesn't read as the app silently going stale.
// Local mode has no host, so useHostStatus() is null and nothing renders
// here (see docs/FRONTEND.md house rule: no pulsing liveness dots — the
// banner itself is the whole affordance, no spinner needed).

import { useHostStatus } from "@/lib/board/useBoard";
import { cn } from "@/lib/utils";

export function ConnectionBanner() {
  const status = useHostStatus();
  const show = status === "disconnected";

  // Hidden ⇒ non-interactive (house rule 4), and unmounted rather than
  // faded: there's nothing inside to keep focusable, and a banner that
  // isn't shown shouldn't reserve layout space above the content pane.
  if (!show) return null;

  return (
    <div
      role="status"
      className={cn(
        "shrink-0 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5",
        "text-[13px] text-destructive",
      )}
    >
      Host disconnected — retrying…
    </div>
  );
}
