// The roster editor — one component, two dressings (docs/FRONTEND.md "The
// roster editor"): a Settings section (variant "settings") and the
// first-project onboarding step (variant "onboarding", "Assemble your
// team"). Built on doctor v2 (src/lib/board/doctor.ts) + setRoster — the
// store is optimistic and host-synced, so every commit saves the full list.
// Local mode swaps the detection list for a connect-a-host note.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { IconChevronRight, IconX } from "@tabler/icons-react";
import { GradientSpin } from "gradient-spin";
import { AgentAvatar } from "@/components/board/glyphs";
import { boardStore, useBoard } from "@/lib/board/useBoard";
import { openDoctor, refreshDoctor, useDoctor, type DoctorRow } from "@/lib/board/doctor";
import { USER, type RosterEntry } from "@/lib/board/types";
import { cn } from "@/lib/utils";

// ── Harness meta (display names + fix-it hints) ───────────────────────────
// The doctor wire shape carries no display names or hints (ORCHESTRATION.md
// "The harness registry") — client-side table, id-derived fallback. Hints
// surface only as title tooltips on "not installed" / "not signed in".

const HARNESS_META: Record<string, { name: string; install?: string; login?: string }> = {
  "claude-code": {
    name: "Claude Code",
    install: "npm install -g @anthropic-ai/claude-code",
    login: "run `claude`, then /login",
  },
  codex: {
    name: "Codex CLI",
    install: "npm install -g @openai/codex",
    login: "codex login",
  },
  grok: { name: "Grok CLI", login: "sign in via the grok CLI" },
  cursor: { name: "Cursor CLI", login: "cursor-agent login" },
  devin: { name: "Devin CLI" },
  opencode: { name: "OpenCode", login: "opencode auth login" },
  pi: { name: "Pi" },
  pool: { name: "Pool" },
  mock: { name: "Mock agent" },
};

function harnessName(id: string): string {
  return (
    HARNESS_META[id]?.name ??
    id.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
  );
}

// Mirrors the seed's roster tints; only the initials fallback ever shows it.
const AGENT_COLORS = ["#7c6df2", "#0f9d8f", "#d97706", "#b5487a", "#5e6ad2", "#8b8d98"];

// ── Handle grammar ─────────────────────────────────────────────────────────
// Handles must match the mention grammar (types.ts parseMentions):
// [a-z0-9][a-z0-9._-]*. Slugified on the way in, never rejected for case.

function slugifyHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "");
}

/** "openai/gpt-5.6-codex" → "gpt-5.6-codex"; de-dupe adds -2, -3, … */
function handleForModel(modelId: string, fallback: string): string {
  const last = modelId.split("/").filter(Boolean).pop() ?? "";
  return slugifyHandle(last) || slugifyHandle(fallback) || "agent";
}

function dedupeHandle(base: string, taken: Set<string>): string {
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base}-${n}`;
  return handle;
}

const NOT_SIGNED_IN = /not (signed|logged) in|logged out|unauthenticated|no api key/i;

// ── The editor ─────────────────────────────────────────────────────────────

export function RosterEditor({
  variant,
  onDone,
}: {
  variant: "settings" | "onboarding";
  /** Onboarding only: the "Start working" primary. */
  onDone?: () => void;
}) {
  const board = useBoard();
  const doctor = useDoctor();

  // Detection just happens on open; reopen re-probes (?refresh=1). No Scan
  // button anywhere. No-op in local mode.
  useEffect(() => {
    openDoctor();
  }, []);

  // The row added last gets its handle focused (prefilled, immediately
  // editable); cleared once claimed so later renders don't steal focus.
  const [focusHandle, setFocusHandle] = useState<string | null>(null);

  const addEntry = (harness: string, model?: string) => {
    const roster = boardStore().getState().roster;
    const taken = new Set([USER, ...roster.map((r) => r.handle)]);
    const handle = dedupeHandle(handleForModel(model ?? "", harness), taken);
    boardStore().setRoster([
      ...roster,
      {
        handle,
        harness,
        model: model?.trim() || undefined,
        color: AGENT_COLORS[roster.length % AGENT_COLORS.length],
      },
    ]);
    setFocusHandle(handle);
  };

  const team = (
    <section className="flex flex-col gap-1">
      <h4 className="text-[12px] font-medium text-muted-foreground select-none">
        Your team
      </h4>
      {board.roster.length === 0 ? (
        <p className="py-1.5 text-[12px] text-muted-foreground">
          No agents on the roster yet.
        </p>
      ) : (
        <div className="flex flex-col">
          {board.roster.map((entry) => (
            <TeamRow
              key={entry.handle}
              entry={entry}
              autoFocus={entry.handle === focusHandle}
              onFocused={() => setFocusHandle(null)}
            />
          ))}
        </div>
      )}
    </section>
  );

  const detection = (
    <section className="flex flex-col gap-1">
      <h4 className="flex items-center gap-2 text-[12px] font-medium text-muted-foreground select-none">
        Available on this machine
        {doctor?.status === "probing" && doctor.rows.length === 0 && (
          <GradientSpin cellSize={2.5} cellGap={1} label="Detecting CLIs" />
        )}
      </h4>
      {doctor == null ? (
        <p className="py-1.5 text-[12px] text-muted-foreground">
          Connect a host to detect CLIs and models.
        </p>
      ) : doctor.status === "error" ? (
        <p className="flex items-center gap-2 py-1.5 text-[12px] text-muted-foreground">
          Couldn't reach the host's doctor.
          <button
            onClick={refreshDoctor}
            className="rounded px-1 text-[12px] text-foreground/80 transition-colors hover:bg-hover hover:text-foreground"
          >
            Retry
          </button>
        </p>
      ) : (
        <div className="flex flex-col">
          {doctor.rows.map((row) => (
            <DetectionRow key={row.id} row={row} roster={board.roster} onAdd={addEntry} />
          ))}
        </div>
      )}
    </section>
  );

  if (variant === "settings") {
    return (
      <div className="flex flex-col gap-4">
        {team}
        {detection}
      </div>
    );
  }

  // Onboarding dress: centered column, heading + subline + the same editor +
  // the "Start working" primary. Skippable — defaults remain if untouched.
  return (
    <div className="flex h-full min-h-0 flex-1 justify-center overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
        className="flex w-full max-w-[34rem] flex-col gap-6 px-6 py-14"
      >
        <header className="flex flex-col gap-2 select-none">
          <h2 className="text-[21px] font-semibold text-foreground">
            Assemble your team
          </h2>
          <p className="text-[13px] leading-[1.5] text-muted-foreground">
            {doctor == null
              ? "Pick the agents you want on the board."
              : "These CLIs are on your machine. Pick the models you want on the board."}
          </p>
        </header>

        {team}
        {detection}

        <div>
          <button
            onClick={onDone}
            className={cn(
              "rounded-md bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background",
              "transition-[opacity,transform] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
              "hover:opacity-90 active:scale-97",
            )}
          >
            Start working
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ── Your team rows ─────────────────────────────────────────────────────────

const cellCls =
  "rounded border border-transparent bg-transparent px-1 outline-none transition-colors " +
  "hover:border-border/60 focus:border-ring focus:bg-background";

function TeamRow({
  entry,
  autoFocus,
  onFocused,
}: {
  entry: RosterEntry;
  autoFocus: boolean;
  onFocused: () => void;
}) {
  const board = useBoard();
  const [hovered, setHovered] = useState(false);

  // Draft + refusal state for the handle cell. The saved roster keeps the
  // old handle until the draft is valid — refusal is inline (red hairline +
  // note), never a throw and never a silent save.
  const [draft, setDraft] = useState(entry.handle);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      handleRef.current?.focus();
      handleRef.current?.select();
      onFocused();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const validate = (value: string): string | null => {
    if (!value) return "Handles can't be empty.";
    if (value === USER) return `"${USER}" is reserved for you.`;
    const taken = board.roster.some((r) => r !== entry && r.handle === value);
    return taken ? `@${value} is already on the roster.` : null;
  };

  const saveRoster = (patch: Partial<RosterEntry>) => {
    const roster = boardStore().getState().roster;
    boardStore().setRoster(
      roster.map((r) => (r.handle === entry.handle ? { ...r, ...patch } : r)),
    );
  };

  const commitHandle = () => {
    const next = slugifyHandle(draft.trim());
    setDraft(next);
    const problem = validate(next);
    setError(problem);
    if (problem || next === entry.handle) return;
    saveRoster({ handle: next });
  };

  const revertHandle = () => {
    setDraft(entry.handle);
    setError(null);
  };

  const remove = () => {
    boardStore().setRoster(
      boardStore().getState().roster.filter((r) => r.handle !== entry.handle),
    );
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group -mx-2 flex flex-col rounded-md px-2 transition-colors duration-100 hover:bg-hover"
    >
      <div className="flex h-8 items-center gap-2">
        <AgentAvatar author={entry.handle} roster={board.roster} size={18} className="shrink-0" />
        <input
          ref={handleRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(validate(slugifyHandle(e.target.value.trim())));
          }}
          onBlur={commitHandle}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation(); // keep the settings dialog open
              revertHandle();
              e.currentTarget.blur();
            }
          }}
          aria-label="Agent handle"
          aria-invalid={error != null}
          className={cn(
            cellCls,
            "w-36 text-[13px] text-foreground",
            error != null && "border-destructive focus:border-destructive",
          )}
        />
        <span className="shrink-0 text-[12px] text-muted-foreground select-none">
          {harnessName(entry.harness)}
        </span>
        <ModelCell
          key={entry.model ?? ""}
          model={entry.model}
          onCommit={(model) => saveRoster({ model })}
        />
        <button
          onClick={remove}
          aria-label={`Remove ${entry.handle}`}
          title={`Remove ${entry.handle}`}
          aria-hidden={!hovered}
          tabIndex={hovered ? 0 : -1}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground",
            "transition-opacity duration-100 hover:bg-active hover:text-foreground",
            hovered ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          <IconX size={13} />
        </button>
      </div>
      {error && (
        <p className="pb-1.5 pl-[26px] text-[12px] text-destructive">{error}</p>
      )}
    </div>
  );
}

// The model pin: 12px muted, editable, empty = harness default. Keyed by the
// saved value so an outside change (host WS push) resets the draft.
function ModelCell({
  model,
  onCommit,
}: {
  model: string | undefined;
  onCommit: (model: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(model ?? "");
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next !== (model ?? "")) onCommit(next || undefined);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setDraft(model ?? "");
          e.currentTarget.blur();
        }
      }}
      placeholder="harness default"
      aria-label="Model pin"
      className={cn(
        cellCls,
        "min-w-0 flex-1 text-[12px] text-muted-foreground placeholder:text-muted-foreground/50",
      )}
    />
  );
}

// ── Detection rows ─────────────────────────────────────────────────────────

/** Status meta for a resolved row + the fix-it tooltip when it needs one. */
function rowMeta(row: DoctorRow): { text: string; tooltip?: string } {
  const meta = HARNESS_META[row.id];
  if (row.found === false) {
    return {
      text: "not installed",
      tooltip: meta?.install ? `Install: ${meta.install}` : `Put \`${row.bin ?? row.id}\` on your PATH.`,
    };
  }
  const version = row.version ? `v${row.version.replace(/^v/, "")}` : null;
  if (row.auth && NOT_SIGNED_IN.test(row.auth)) {
    return {
      text: [version, "not signed in"].filter(Boolean).join(" · "),
      tooltip: meta?.login ? `Sign in: ${meta.login}` : undefined,
    };
  }
  const text = [version, row.auth].filter(Boolean).join(" · ") || "installed";
  return { text, tooltip: row.discoveryError };
}

function DetectionRow({
  row,
  roster,
  onAdd,
}: {
  row: DoctorRow;
  roster: RosterEntry[];
  onAdd: (harness: string, model?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable = row.found === true;
  const meta = rowMeta(row);

  // AgentAvatar's mark/initials logic, keyed by a synthesized one-entry
  // roster — detection rows have no real roster entry to point at. pi/pool
  // have no brand mark and land on the initials circle, deliberately.
  const markRoster = useMemo<RosterEntry[]>(
    () => [{ handle: row.id, harness: row.id, color: "#8b8d98" }],
    [row.id],
  );

  const inner = (
    <>
      <IconChevronRight
        size={13}
        className={cn(
          "shrink-0 text-muted-foreground transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
          open && "rotate-90",
          !expandable && "invisible",
        )}
      />
      <AgentAvatar author={row.id} roster={markRoster} size={18} className="shrink-0" />
      <span className="shrink-0 text-[13px] text-foreground select-none">
        {harnessName(row.id)}
      </span>
      {row.pending ? (
        <GradientSpin cellSize={2.5} cellGap={1} label="Probing" className="ml-1" />
      ) : (
        <span
          title={meta.tooltip}
          className="min-w-0 truncate text-[12px] text-muted-foreground select-none"
        >
          {meta.text}
        </span>
      )}
    </>
  );

  const rowCls = "-mx-2 flex h-8 items-center gap-2 rounded-md px-2 text-left transition-colors duration-100";

  return (
    <div className="flex flex-col">
      {/* A plain div when there's nothing to expand — a disabled button
          would swallow hover, killing the fix-it title tooltip. */}
      {expandable ? (
        <button
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(rowCls, "hover:bg-hover")}
        >
          {inner}
        </button>
      ) : (
        <div className={cn(rowCls, "cursor-default")}>{inner}</div>
      )}

      {expandable && open && (
        <div className="flex flex-col pb-1 pl-[25px]">
          {row.models?.length ? (
            row.models.map((model) => (
              <ModelAddRow
                key={model}
                model={model}
                added={roster.some((r) => r.harness === row.id && r.model === model)}
                onAdd={() => onAdd(row.id, model)}
              />
            ))
          ) : (
            // No programmatic discovery (models: null, or nothing reported):
            // one free-text add row — the model rides the roster pin.
            <FreeAddRow onAdd={(model) => onAdd(row.id, model)} />
          )}
        </div>
      )}
    </div>
  );
}

function ModelAddRow({
  model,
  added,
  onAdd,
}: {
  model: string;
  added: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="-mx-2 flex h-7 items-center gap-2 rounded-md px-2 transition-colors duration-100 hover:bg-hover">
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/80">{model}</span>
      {added ? (
        <span className="shrink-0 text-[12px] text-muted-foreground/70 select-none">Added</span>
      ) : (
        <button
          onClick={onAdd}
          className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors duration-100 hover:bg-active hover:text-foreground"
        >
          Add
        </button>
      )}
    </div>
  );
}

function FreeAddRow({ onAdd }: { onAdd: (model?: string) => void }) {
  const [model, setModel] = useState("");
  const add = () => {
    onAdd(model.trim() || undefined);
    setModel("");
  };
  return (
    <div className="flex h-8 items-center gap-2">
      <input
        value={model}
        onChange={(e) => setModel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        placeholder="model — uses the CLI's default when empty"
        aria-label="Model for the new agent"
        className={cn(cellCls, "min-w-0 flex-1 text-[12px] text-foreground placeholder:text-muted-foreground/50")}
      />
      <button
        onClick={add}
        className="shrink-0 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors duration-100 hover:bg-active hover:text-foreground"
      >
        Add agent
      </button>
    </div>
  );
}
