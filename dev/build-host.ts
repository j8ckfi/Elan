// Compile the Elan host into the self-contained binaries Tauri ships as a
// sidecar (`externalBin` in src-tauri/tauri.conf.json — the release-mode host
// that src-tauri/src/host.rs spawns next to the app executable). Run via
// `bun run build:host`, chained into beforeBuildCommand.
//
// Three artifacts, because the bundler resolves a sidecar by target triple and
// we build for two of them:
//   elan-host-aarch64-apple-darwin    plain `tauri build` on Apple silicon
//   elan-host-x86_64-apple-darwin     plain `tauri build` on Intel
//   elan-host-universal-apple-darwin  the release workflow's --target universal
//
// The universal slice is lipo'd from the other two. That it works at all is
// worth knowing: `bun build --compile` appends its JS payload *past* the
// Mach-O, which lipo has no reason to preserve — but both slices locate the
// payload at the end of the fat file, and the bundle is the same
// arch-independent JS either way. Verified by booting both (arm64 native,
// x86_64 under Rosetta) and serving GET /api/state. So don't "fix" this into a
// plain copy of one arch on the assumption the fat binary is broken.

import { $ } from "bun";

const SRC = "dev/elan-host.ts";
const OUT = "src-tauri/binaries";

const SLICES = [
  { bunTarget: "bun-darwin-arm64", triple: "aarch64-apple-darwin" },
  { bunTarget: "bun-darwin-x64", triple: "x86_64-apple-darwin" },
] as const;

await $`mkdir -p ${OUT}`;

for (const { bunTarget, triple } of SLICES) {
  await $`bun build --compile --target=${bunTarget} ${SRC} --outfile ${OUT}/elan-host-${triple}`;
}

await $`lipo -create -output ${OUT}/elan-host-universal-apple-darwin \
  ${OUT}/elan-host-aarch64-apple-darwin ${OUT}/elan-host-x86_64-apple-darwin`;

console.log(`built ${SLICES.length + 1} host binaries in ${OUT}/`);
