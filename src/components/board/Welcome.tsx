// First run: a fresh board (`projects.length === 0`) never shows demo data —
// it shows this, centered in the content pane. See docs/FRONTEND.md "First
// run (Welcome)". Pure function of a callback; the board itself is read by
// App to decide whether to mount this at all.

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { boardStore } from "@/lib/board/useBoard";
import { cn } from "@/lib/utils";

const isDesktop = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Last non-empty path segment: "/Users/me/repo/" → "repo". */
function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

/** Desktop only — the browser dev path has no native picker (see the inline
 *  form below instead). Mirrors ProjectBreadcrumb's pickDirectory. */
async function pickDirectory(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === "string" ? picked : null;
}

export function Welcome({
  onProjectCreated,
}: {
  onProjectCreated: (projectId: string) => void;
}) {
  const [addingPath, setAddingPath] = useState(false);
  const [path, setPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (addingPath) inputRef.current?.focus();
  }, [addingPath]);

  const create = (repoPath: string) => {
    const trimmed = repoPath.trim();
    if (!trimmed) return;
    const project = boardStore().createProject({
      name: basename(trimmed),
      repoPath: trimmed,
    });
    onProjectCreated(project.id);
  };

  const openProject = async () => {
    if (isDesktop()) {
      const dir = await pickDirectory();
      if (dir) create(dir);
      return;
    }
    setAddingPath(true);
  };

  const cancelPath = () => {
    setAddingPath(false);
    setPath("");
  };

  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
        className="flex max-w-[26rem] flex-col items-center gap-6 px-6 text-center select-none"
      >
        <span className="text-[15px] font-medium text-muted-foreground">
          Elan
        </span>

        <div className="flex flex-col gap-3">
          <p className="text-[21px] font-semibold leading-snug text-foreground">
            An issue tracker where the assignees are your model
            subscriptions.
          </p>
          <p className="text-[13px] leading-[1.5] text-muted-foreground">
            File a thread, tag an agent, watch it work. Agents plan, argue,
            review, and merge on a shared board — you only see the surface.
          </p>
        </div>

        {addingPath ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              create(path);
            }}
            className="flex items-center gap-2"
          >
            <input
              ref={inputRef}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelPath();
                }
              }}
              placeholder="/path/to/repo"
              className={cn(
                "w-64 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[13px] text-foreground outline-none",
                "placeholder:text-muted-foreground/50 focus:border-foreground/25",
              )}
            />
            <button
              type="submit"
              disabled={!path.trim()}
              className={cn(
                "rounded-md border border-border px-3 py-1.5 text-[13px] text-foreground",
                "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "hover:bg-hover active:scale-97 disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              Add
            </button>
            <button
              type="button"
              onClick={cancelPath}
              className={cn(
                "rounded-md px-2 py-1.5 text-[13px] text-muted-foreground",
                "transition-colors duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "hover:bg-hover hover:text-foreground active:scale-97",
              )}
            >
              Esc
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-4">
            <button
              onClick={openProject}
              className={cn(
                "rounded-md bg-foreground px-3.5 py-1.5 text-[13px] font-medium text-background",
                "transition-[opacity,transform] duration-100 ease-[cubic-bezier(0.23,1,0.32,1)]",
                "hover:opacity-90 active:scale-97",
              )}
            >
              Open a project…
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
