// Human label + icon for a tool call, shared across adapters.
//
// Most coding-agent CLIs converge on the same core tools (bash/read/edit/
// write/grep…), so the default table matches case-insensitively on the tool
// name and digs common argument keys for context. Adapters can layer their own
// names on top via the `overrides` parameter.

export interface StepMeta {
  /** Fluid icon-map name (see src/lib/icon-map.tsx). */
  icon: string;
  label: string;
}

export type StepMetaFn = (args: Record<string, unknown>) => StepMeta;

function basename(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
function short(s: unknown, n = 48): string {
  if (typeof s !== "string") return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

const DEFAULTS: Record<string, StepMetaFn> = {
  bash: (a) => ({ icon: "monitor", label: `Ran ${short(a.command, 40)}` }),
  read: (a) => ({
    icon: "square-library",
    label: `Read ${basename(a.file_path ?? a.path)}`,
  }),
  edit: (a) => ({
    icon: "pencil",
    label: `Edited ${basename(a.file_path ?? a.path)}`,
  }),
  write: (a) => ({
    icon: "pencil",
    label: `Wrote ${basename(a.file_path ?? a.path)}`,
  }),
  grep: (a) => ({ icon: "search", label: `Searched for ${short(a.pattern, 32)}` }),
  find: (a) => ({
    icon: "search",
    label: `Found files ${short(a.pattern ?? a.query, 28)}`,
  }),
  glob: (a) => ({
    icon: "search",
    label: `Found files ${short(a.pattern ?? a.query, 28)}`,
  }),
  ls: (a) => ({
    icon: "square-library",
    label: `Listed ${basename(a.path) || "directory"}`,
  }),
  websearch: (a) => ({
    icon: "search",
    label: `Searched the web for ${short(a.query, 28)}`,
  }),
  webfetch: (a) => ({ icon: "search", label: `Fetched ${short(a.url, 36)}` }),
};

/** Resolve display meta for a tool call. `overrides` (keyed lowercase) wins
 *  over the shared defaults; unknown tools fall back to "Used <name>". */
export function toolStepMeta(
  name: string,
  args: unknown,
  overrides?: Record<string, StepMetaFn>,
): StepMeta {
  const a = (args ?? {}) as Record<string, unknown>;
  const fn = overrides?.[name.toLowerCase()] ?? DEFAULTS[name.toLowerCase()];
  return fn ? fn(a) : { icon: "dot", label: `Used ${name}` };
}
