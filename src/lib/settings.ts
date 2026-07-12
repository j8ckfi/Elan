// App settings — persisted, reactive, platform-agnostic.
//
// Storage is plain localStorage: it works identically in the Tauri webview
// (persisted in the app's data dir) and in browser dev, so no store plugin or
// Rust round-trip is needed. Anything that must reach the host (the CLI
// binary path / extra PATH dirs) is read at spawn-build time and travels
// inside the SpawnSpec — Rust stays stateless.

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

export type ThemePref = "system" | "light" | "dark";

export interface Settings {
  /** Light/dark/system. `system` follows the OS, live. */
  theme: ThemePref;
  /** Frost the sidebar with native macOS glass (desktop app only). */
  glassSidebar: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  glassSidebar: false,
};

const STORAGE_KEY = "elan.settings";

const THEME_VALUES: ThemePref[] = ["system", "light", "dark"];

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // Pick known keys explicitly so stale persisted keys don't ride along.
    const theme =
      parsed.theme && THEME_VALUES.includes(parsed.theme)
        ? parsed.theme
        : DEFAULT_SETTINGS.theme;
    return {
      theme,
      glassSidebar: parsed.glassSidebar ?? DEFAULT_SETTINGS.glassSidebar,
    };
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
