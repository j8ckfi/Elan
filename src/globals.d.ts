// Ambient declarations for untyped icon packages that Fluid's icon-map
// references. Mari uses Tabler; these subpath imports (Hugeicons / UntitledUI)
// ship no .d.ts, so declare them as `any` to satisfy the type checker without
// pulling in nonexistent types.
declare module "@hugeicons/core-free-icons/*";
declare module "@untitledui/icons/*";
