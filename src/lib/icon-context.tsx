"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

import {
  iconMap,
  type IconLibrary,
  type IconName,
  type IconComponent,
} from "@/lib/icon-map";

// Re-export types for consumers
export type { IconComponent, IconName, IconLibrary } from "@/lib/icon-map";
export { iconLibraryOrder, iconLibraryLabels } from "@/lib/icon-map";

interface IconContextValue {
  iconLibrary: IconLibrary;
  setIconLibrary: (lib: IconLibrary) => void;
}

const IconContext = createContext<IconContextValue | null>(null);

/**
 * Returns the current icon library and setter.
 * Throws if used outside IconProvider.
 */
function useIconLibrary() {
  const ctx = useContext(IconContext);
  if (!ctx) throw new Error("useIconLibrary must be used within an IconProvider");
  return ctx;
}

/**
 * Returns a single icon component for the given name.
 * Falls back to Lucide if no provider is present.
 */
function useIcon(name: IconName): IconComponent {
  const ctx = useContext(IconContext);
  if (!ctx) return iconMap.lucide[name];
  return iconMap[ctx.iconLibrary][name];
}

/**
 * Returns the full icon map for the current library.
 * Falls back to Lucide if no provider is present.
 */
function useIcons(): Record<IconName, IconComponent> {
  const ctx = useContext(IconContext);
  const lib = ctx?.iconLibrary ?? "lucide";
  // iconMap is a module-level constant, so iconMap[lib] is already stable.
  return iconMap[lib];
}

function IconProvider({
  children,
  defaultLibrary = "lucide",
}: {
  children: ReactNode;
  defaultLibrary?: IconLibrary;
}) {
  const [iconLibrary, setIconLibraryState] = useState<IconLibrary>(defaultLibrary);

  const setIconLibrary = useCallback((next: IconLibrary) => {
    setIconLibraryState(next);
  }, []);

  const value = useMemo(
    () => ({ iconLibrary, setIconLibrary }),
    [iconLibrary, setIconLibrary]
  );

  return (
    <IconContext.Provider value={value}>
      {children}
    </IconContext.Provider>
  );
}

export { IconProvider, useIcon, useIcons, useIconLibrary };
