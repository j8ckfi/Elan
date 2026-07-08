// Auto-update client — a thin wrapper over @tauri-apps/plugin-updater that
// no-ops cleanly outside the desktop app (browser dev). The app checks GitHub
// Releases' latest.json (configured in tauri.conf.json), verifies the minisign
// signature, then downloads + relaunches on request.

import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@/lib/pi/client";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdatePhase =
  | "idle" // haven't checked
  | "checking"
  | "uptodate"
  | "available"
  | "downloading"
  | "error"
  | "unsupported"; // not the desktop app

export interface UpdaterState {
  phase: UpdatePhase;
  version?: string; // the newer version, when available
  error?: string;
}

export interface Updater extends UpdaterState {
  /** Check GitHub Releases for a newer version. */
  check: () => Promise<void>;
  /** Download + install the pending update, then relaunch. */
  install: () => Promise<void>;
}

export function useUpdater(): Updater {
  const [state, setState] = useState<UpdaterState>({
    phase: isTauri() ? "idle" : "unsupported",
  });
  // The resolved Update handle from the last successful check.
  const pending = useRef<Update | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = useCallback((s: UpdaterState) => {
    if (mounted.current) setState(s);
  }, []);

  const check = useCallback(async () => {
    if (!isTauri()) return set({ phase: "unsupported" });
    set({ phase: "checking" });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      pending.current = update;
      if (update) set({ phase: "available", version: update.version });
      else set({ phase: "uptodate" });
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  }, [set]);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    set({ phase: "downloading", version: update.version });
    try {
      await update.downloadAndInstall();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ phase: "error", error: String(e) });
    }
  }, [set]);

  return { ...state, check, install };
}
