// App settings — persisted, reactive, platform-agnostic.
//
// Storage is plain localStorage: it works identically in the Tauri webview
// (persisted in the app's data dir) and in browser dev, so no store plugin or
// Rust round-trip is needed. Anything that must reach the Rust side (the pi
// binary path / extra PATH dirs) is read here and passed through pi_start's
// options — Rust stays stateless.

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useState,
  createElement,
  type ReactNode,
} from "react";
import type { ThinkingLevel } from "@/lib/agent/types";

export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  /** Light/dark/system. `system` follows the OS, live. */
  theme: ThemePref;
  /** Working directory new sessions open in (null → the user's home). */
  defaultCwd: string | null;
  /** Model new sessions start on, as `provider/id`. */
  defaultModel: string;
  /** Thinking level applied to new sessions (null → leave the model default). */
  defaultThinking: ThinkingLevel | null;
  /** Explicit path to the `pi` binary ("" → auto-resolve). */
  piBinPath: string;
  /** Extra directories prepended to the spawned pi's PATH, one per line. */
  extraPathDirs: string;
  /** How many idle sessions to keep warm before reaping. */
  warmPoolSize: number;
  /** Check GitHub Releases for updates on launch. */
  autoCheckUpdates: boolean;
  /** Frost the sidebar with native macOS glass (desktop app only). */
  glassSidebar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  defaultCwd: null,
  defaultModel: "openai-codex/gpt-5.5",
  defaultThinking: null,
  piBinPath: "",
  extraPathDirs: "",
  warmPoolSize: 5,
  autoCheckUpdates: true,
  glassSidebar: false,
};

const STORAGE_KEY = "mari.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Merge over defaults so a new field added later is filled in, and a
    // corrupt/partial value can't leave a key undefined.
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persist(s: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage disabled — settings just won't survive a restart */
  }
}

// Parse the newline/colon-separated extra-PATH field into clean dir entries.
export function parsePathDirs(raw: string): string[] {
  return raw
    .split(/[\n:]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── Theme application ──────────────────────────────────────────────────────
// Toggles `.dark` (shadcn/Fluid convention) + native color-scheme. Returns a
// cleanup for the OS-change listener so `system` tracks live.
function applyTheme(pref: ThemePref): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const set = (dark: boolean) => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  };
  if (pref === "system") {
    set(mq.matches);
    const onChange = (e: MediaQueryListEvent) => set(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }
  set(pref === "dark");
  return () => {};
}

// ── Context ────────────────────────────────────────────────────────────────
interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(load);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      persist(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    persist(DEFAULT_SETTINGS);
    setSettings({ ...DEFAULT_SETTINGS });
  }, []);

  // Keep the theme in sync with the pref (and the live OS change for `system`).
  useEffect(() => applyTheme(settings.theme), [settings.theme]);

  const value = useMemo(
    () => ({ settings, update, reset }),
    [settings, update, reset],
  );

  return createElement(SettingsContext.Provider, { value }, children);
}

export function useSettings(): Settings {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within <SettingsProvider>");
  return ctx.settings;
}

export function useSettingsActions(): Omit<SettingsContextValue, "settings"> {
  const ctx = useContext(SettingsContext);
  if (!ctx)
    throw new Error("useSettingsActions must be used within <SettingsProvider>");
  const { update, reset } = ctx;
  return { update, reset };
}
