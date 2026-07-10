// The settings panel. Reads/writes the persisted Settings (see lib/settings).
// Grouped into General / Models / Pi / Sessions / About. Plain controls, styled
// to match the app — no heavy pickers, since this is a low-traffic form.

import { type ReactNode } from "react";
import { IconExternalLink } from "@tabler/icons-react";
import { useUpdater } from "@/lib/updater";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { RosterEditor } from "@/components/board/RosterEditor";
import {
  useSettings,
  useSettingsActions,
  type ThemePref,
} from "@/lib/settings";
import type { ThinkingLevel } from "@/lib/agent/types";
import { THINKING_LABELS } from "@/lib/agent/thinking";

const REPO_URL = "https://github.com/j8ckfi/Mari";

const inputCls =
  "h-8 w-full rounded-[5px] border border-border bg-transparent px-2.5 text-[13px] " +
  "text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 " +
  "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30";

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const s = useSettings();
  const { update, reset } = useSettingsActions();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The panel stays solid; scrolling + the scroll-fade mask live on an
          inner wrapper so only the CONTENT dissolves toward the clipped edge
          (a mask on the panel itself would fade its background to transparent).
          -m-6/p-6 reclaims the panel padding so the scrollport — and the fade —
          reach the true panel edges. */}
      <DialogContent size="lg" className="flex max-h-[85vh] flex-col">
        <div className="scroll-fade -m-6 min-h-0 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-6 py-1">
          {/* ── General ─────────────────────────────────────────────── */}
          <Section title="General">
            <Field label="Theme" desc="Light, dark, or follow the system.">
              <Segmented<ThemePref>
                value={s.theme}
                onChange={(v) => update({ theme: v })}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </Field>
            <Field
              label="Glass sidebar"
              desc="Frost the sidebar with native macOS glass. Desktop app only."
            >
              <Toggle
                checked={s.glassSidebar}
                onChange={(v) => update({ glassSidebar: v })}
              />
            </Field>
            <Field
              stack
              label="Default working directory"
              desc="Where new sessions open. Blank uses your home folder."
            >
              <input
                className={inputCls}
                placeholder="~/code/project"
                value={s.defaultCwd ?? ""}
                onChange={(e) =>
                  update({ defaultCwd: e.target.value.trim() || null })
                }
              />
            </Field>
          </Section>

          {/* ── Agents ──────────────────────────────────────────────── */}
          {/* The roster editor (docs/FRONTEND.md "The roster editor") in its
              settings dressing — detection re-probes on every dialog open. */}
          <Section title="Agents">
            <RosterEditor variant="settings" />
          </Section>

          {/* ── Models ──────────────────────────────────────────────── */}
          <Section title="Models">
            <Field
              stack
              label="Default model"
              desc="Model new sessions start on, as provider/id."
            >
              <input
                className={cn(inputCls, "font-mono text-[12px]")}
                placeholder="openai-codex/gpt-5.5"
                value={s.defaultModel}
                onChange={(e) => update({ defaultModel: e.target.value.trim() })}
              />
            </Field>
            <Field
              label="Default thinking level"
              desc="Applied to new sessions when the model supports it."
            >
              <select
                className={cn(inputCls, "cursor-pointer")}
                value={s.defaultThinking ?? ""}
                onChange={(e) =>
                  update({
                    defaultThinking: (e.target.value || null) as
                      | ThinkingLevel
                      | null,
                  })
                }
              >
                <option value="">Model default</option>
                {(
                  ["off", "minimal", "low", "medium", "high", "xhigh"] as const
                ).map((l) => (
                  <option key={l} value={l}>
                    {THINKING_LABELS[l]}
                  </option>
                ))}
              </select>
            </Field>
          </Section>

          {/* ── Pi ──────────────────────────────────────────────────── */}
          <Section title="Pi runtime">
            <Field
              stack
              label="Pi binary path"
              desc="Override where Mari finds pi. Blank auto-resolves (~/.local/bin, PATH)."
            >
              <input
                className={cn(inputCls, "font-mono text-[12px]")}
                placeholder="/Users/you/.local/bin/pi"
                value={s.piBinPath}
                onChange={(e) => update({ piBinPath: e.target.value.trim() })}
              />
            </Field>
            <Field
              stack
              label="Extra PATH directories"
              desc="Prepended to the spawned pi's PATH — one directory per line. Helps when pi's node runtime lives somewhere unusual."
            >
              <textarea
                className={cn(inputCls, "h-auto min-h-[64px] resize-y py-1.5 font-mono text-[12px]")}
                placeholder={"/opt/homebrew/bin\n~/.bun/bin"}
                value={s.extraPathDirs}
                onChange={(e) => update({ extraPathDirs: e.target.value })}
              />
            </Field>
          </Section>

          {/* ── Sessions ────────────────────────────────────────────── */}
          <Section title="Sessions">
            <Field
              label="Warm session pool"
              desc="How many idle sessions stay running (fast to reopen) before Mari reaps them. Running sessions are always kept."
            >
              <input
                type="number"
                min={0}
                max={20}
                className={cn(inputCls, "w-24")}
                value={s.warmPoolSize}
                onChange={(e) => {
                  const n = Math.max(0, Math.min(20, Number(e.target.value) || 0));
                  update({ warmPoolSize: n });
                }}
              />
            </Field>
          </Section>

          {/* ── About ───────────────────────────────────────────────── */}
          <Section title="About">
            <Field
              label="Automatic updates"
              desc="Check GitHub Releases for a new version on launch."
            >
              <Toggle
                checked={s.autoCheckUpdates}
                onChange={(v) => update({ autoCheckUpdates: v })}
              />
            </Field>
            <Field
              label="Updates"
              desc="Mari updates from signed GitHub Releases."
            >
              <UpdatesControl />
            </Field>
            <div className="flex items-center justify-between">
              <div className="text-[13px] text-muted-foreground">
                Mari <span className="tabular-nums">v{__APP_VERSION__}</span>
              </div>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
              >
                GitHub <IconExternalLink size={13} />
              </a>
            </div>
          </Section>

          <div className="flex justify-end border-t border-border/70 pt-4">
            <button
              onClick={reset}
              className="rounded-[5px] px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
            >
              Reset to defaults
            </button>
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Compact "check for updates" control. No-ops (disabled) in browser dev where
// the updater is unavailable.
function UpdatesControl() {
  const u = useUpdater();
  const btn =
    "rounded-[5px] border border-border px-2.5 py-1 text-[12px] transition-colors " +
    "hover:bg-hover disabled:opacity-50 disabled:pointer-events-none";

  if (u.phase === "unsupported") {
    return (
      <span className="text-[12px] text-muted-foreground">Desktop app only</span>
    );
  }
  if (u.phase === "available") {
    return (
      <button
        className={cn(btn, "text-foreground")}
        onClick={() => void u.download().then(u.restart)}
      >
        Update to v{u.version} → install &amp; relaunch
      </button>
    );
  }
  if (u.phase === "downloading") {
    return (
      <span className="text-[12px] text-muted-foreground">
        Downloading v{u.version}
        {u.progress != null ? ` ${Math.round(u.progress * 100)}%` : "…"}
      </span>
    );
  }
  if (u.phase === "downloaded") {
    return (
      <button className={cn(btn, "text-foreground")} onClick={u.restart}>
        Restart app to update
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button
        className={btn}
        disabled={u.phase === "checking"}
        onClick={u.check}
      >
        {u.phase === "checking" ? "Checking…" : "Check for updates"}
      </button>
      {u.phase === "uptodate" && (
        <span className="text-[12px] text-muted-foreground">Up to date</span>
      )}
      {u.phase === "error" && (
        <span className="text-[12px] text-destructive">Check failed</span>
      )}
    </div>
  );
}

// ── Layout helpers ──────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
        {title}
      </h3>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

// `stack` puts a wide control (text/textarea/select) on its own row under the
// label; the default inline layout right-aligns a compact control (toggle,
// segmented, number) next to the label.
function Field({
  label,
  desc,
  stack,
  children,
}: {
  label: string;
  desc?: string;
  stack?: boolean;
  children: ReactNode;
}) {
  if (stack) {
    return (
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-foreground">{label}</label>
        {desc && (
          <p className="text-[12px] leading-snug text-muted-foreground">{desc}</p>
        )}
        <div className="mt-0.5">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-4">
        <label className="text-[13px] font-medium text-foreground">{label}</label>
        <div className="shrink-0">{children}</div>
      </div>
      {desc && (
        <p className="max-w-[85%] text-[12px] leading-snug text-muted-foreground">
          {desc}
        </p>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-[6px] border border-border p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[4px] px-2.5 py-1 text-[12px] transition-colors",
            value === o.value
              ? "bg-active text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        checked ? "bg-foreground" : "bg-border",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background transition-transform",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}
