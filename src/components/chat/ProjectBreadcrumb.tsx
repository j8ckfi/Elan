// Breadcrumb: 📁 <project> › <thread>. The folder segment is a dropdown —
// recent project directories (from session history) plus "Open folder…", which
// opens the native picker (Finder on desktop). Picking one restarts Pi rooted
// there, so new chats run in that directory. Mirrors Cursor's project switcher.

import { Menu } from "@base-ui/react/menu";
import {
  IconFolder,
  IconFolderPlus,
  IconChevronRight,
  IconChevronDown,
  IconCheck,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";

function basename(cwd?: string): string {
  if (!cwd) return "Mari";
  return cwd.split(/[/\\]/).filter(Boolean).pop() || cwd;
}

/** Prettify an absolute path for display: /Users/me/Documents/x → ~/Documents/x */
function shortPath(cwd: string): string {
  return cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

async function pickDirectory(): Promise<string | null> {
  // Desktop: the real native folder picker (Finder).
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === "string" ? picked : null;
  }
  // Browser dev has no absolute-path picker; let the user paste one.
  const p = window.prompt("Open project folder — absolute path:");
  return p && p.trim() ? p.trim() : null;
}

export function ProjectBreadcrumb({
  cwd,
  thread,
  recents,
  onSelectProject,
  readonly = false,
}: {
  cwd?: string;
  /** Omitted for a fresh chat — the breadcrumb is then just the folder. */
  thread?: string;
  recents: string[];
  onSelectProject: (cwd: string) => void;
  /** Display-only: render the folder as plain text (no dropdown affordance).
   *  Used in the conversation header, where it's a label, not a control. */
  readonly?: boolean;
}) {
  const openFolder = async () => {
    const dir = await pickDirectory();
    if (dir) onSelectProject(dir);
  };

  // Display-only breadcrumb: just the folder name (+ thread), no interactivity.
  if (readonly) {
    return (
      <div className="flex min-w-0 items-center gap-1 text-[13px] select-none">
        <div className="flex shrink-0 items-center gap-1.5 px-1.5 py-1 text-foreground/55">
          <IconFolder size={14} className="shrink-0" />
          <span className="max-w-[12rem] truncate">{basename(cwd)}</span>
        </div>
        {thread && (
          <>
            <IconChevronRight
              size={13}
              className="shrink-0 text-foreground/25"
            />
            <span className="min-w-0 truncate font-medium text-foreground/85">
              {thread}
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1 text-[13px]">
      <Menu.Root>
        <Menu.Trigger
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 outline-none",
            "text-foreground/55 transition-[transform,color,background-color] duration-100",
            "ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-hover hover:text-foreground/85",
            "active:scale-[0.96] data-[popup-open]:bg-hover data-[popup-open]:text-foreground/85",
          )}
        >
          <IconFolder size={14} className="shrink-0" />
          <span className="max-w-[12rem] truncate">{basename(cwd)}</span>
          <IconChevronDown size={12} className="shrink-0 opacity-50" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={6} className="z-50">
            <Menu.Popup
              className={cn(
                "z-50 min-w-[15rem] origin-[var(--transform-origin)] overflow-hidden",
                "rounded-xl border border-border bg-popover text-[13px] shadow-lg",
                "dark:border-transparent dark:shadow-surface-2",
                "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
                "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-100",
              )}
            >
              {recents.length > 0 && (
                <>
                  {/* Recents scroll with a fade-off so a long list reads as
                      clipped; the mask sits on the viewport, over the solid
                      popover bg, so only the content dissolves. */}
                  <div className="scroll-fade max-h-[min(22rem,52vh)] overflow-y-auto p-1">
                    <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground/70">
                      Recents
                    </div>
                    {recents.map((dir) => (
                      <Menu.Item
                        key={dir}
                        onClick={() => onSelectProject(dir)}
                        className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-hover"
                      >
                        <IconFolder
                          size={14}
                          className="shrink-0 text-muted-foreground"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {shortPath(dir)}
                        </span>
                        {dir === cwd && (
                          <IconCheck
                            size={14}
                            className="shrink-0 text-foreground/70"
                          />
                        )}
                      </Menu.Item>
                    ))}
                  </div>
                  <Menu.Separator className="h-px bg-border" />
                </>
              )}
              {/* Open folder — pinned below the scroll area, always reachable. */}
              <div className="p-1">
                <Menu.Item
                  onClick={openFolder}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none select-none data-[highlighted]:bg-hover"
                >
                  <IconFolderPlus
                    size={14}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span>Open folder…</span>
                </Menu.Item>
              </div>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>

      {thread && (
        <>
          <IconChevronRight size={13} className="shrink-0 text-foreground/25" />
          <span className="min-w-0 truncate font-medium text-foreground/85">
            {thread}
          </span>
        </>
      )}
    </div>
  );
}
