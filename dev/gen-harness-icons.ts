// Regenerates src/components/board/harness-icons.ts from
// @lobehub/icons-static-svg (devDependency) — the de-facto AI brand icon set.
// Marks are mono (fill="currentColor"), so they render in the system color:
// dark on light, light on dark. Run after adding a harness:
//
//   bun dev/gen-harness-icons.ts
//
// Add the new harness → icon-file mapping below first.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// harness/adapter id → lobehub icon basename
// pi has no mark anywhere — it falls back to the initials circle
// (glyphs.tsx), deliberately. pool ships from LOCAL_ICONS below.
const ICONS: Record<string, string> = {
  "claude-code": "claude", // the Claude spark, not the Anthropic wordmark
  codex: "openai", // the OpenAI blossom
  grok: "grok", // the black hole
  cursor: "cursor",
  devin: "devin",
  opencode: "opencode",
};

// Marks lobehub doesn't carry, embedded from official brand sources. The
// glyph path only — masks/gradients from presskits are fade effects we drop;
// AgentAvatar renders everything in the system color (currentColor).
const LOCAL_ICONS: Record<string, { viewBox: string; paths: string[]; source: string }> = {
  pool: {
    // Poolside presskit (provided by the user, 2026-07-10). Brand fill
    // #4137FF intentionally discarded per the system-color rule.
    viewBox: "0 0 32 32",
    paths: [
      "M8.98976 30.3815C6.02045 28.9329 3.60852 26.6447 2.01266 23.7643C0.453682 20.9498 -0.219858 17.775 0.0629571 14.5827C0.126988 13.8674 0.757216 13.3392 1.47289 13.4024C2.18722 13.466 2.71622 14.0968 2.65309 14.8126C2.41613 17.4865 2.98128 20.1467 4.28757 22.5053C5.41219 24.536 7.023 26.2153 8.9891 27.4192L15.1043 14.8784C12.7106 14.0812 10.7169 14.4282 10.5375 14.4631C10.5112 14.4692 10.4858 14.4735 10.4599 14.4786C9.86386 14.5784 9.28735 14.2527 9.05527 13.7111C8.73499 13.1131 7.77341 11.6515 6.60959 11.0837C5.44577 10.516 3.65213 10.6991 3.07471 10.8246C2.58789 10.931 2.08122 10.7494 1.77371 10.358C1.4662 9.9665 1.40726 9.43259 1.62554 8.98496C5.48998 1.05529 15.087 -2.24965 23.0153 1.61816C30.9437 5.48598 34.2453 15.0756 30.3875 23.003C30.3836 23.0111 30.3796 23.0192 30.3752 23.0282C26.504 30.949 16.9145 34.2476 8.98976 30.3815ZM17.44 16.0179L11.3253 28.5578C17.4968 30.8631 24.5196 28.3019 27.731 22.4803C27.2796 21.7817 26.4875 20.78 25.5709 20.3328C24.3864 19.7549 22.6509 19.9442 22.0547 20.0695C21.9566 20.0928 21.8588 20.1041 21.7604 20.105C21.5842 20.1059 21.4054 20.071 21.2339 19.9962C21.056 19.9183 20.8952 19.8009 20.7654 19.6497C20.6912 19.5623 20.6299 19.4667 20.5806 19.3648C20.5422 19.2882 19.5939 17.4481 17.4391 16.0175L17.44 16.0179ZM7.74737 8.74582C8.74313 9.2316 9.5548 10.0037 10.1608 10.7321C12.0348 7.86545 14.578 5.70023 16.5425 4.3042C17.2726 3.78579 18.0284 3.30111 18.7563 2.88291C13.6429 1.80923 8.28375 3.83577 5.1764 8.10245C5.99889 8.15876 6.90528 8.33501 7.74737 8.74582ZM24.6415 5.75507C24.7602 6.58628 24.8441 7.47954 24.8847 8.37503C24.9943 10.7762 24.8555 14.1022 23.7588 17.3369C24.6735 17.3614 25.7372 17.5232 26.7105 17.998C27.5795 18.4219 28.3081 19.0633 28.8814 19.7035C30.3453 14.6184 28.6441 9.13194 24.6411 5.75597L24.6415 5.75507ZM17.4489 13.0336C19.2472 13.9109 20.5471 15.078 21.4282 16.0842C22.8614 11.427 22.2366 6.21527 21.7149 4.28506C19.873 5.06221 15.3815 7.77795 12.5957 11.7753C13.9322 11.8499 15.6515 12.1568 17.4489 13.0336Z",
    ],
    source: "Poolside presskit",
  },
};

const SRC = join(import.meta.dir, "..", "node_modules", "@lobehub/icons-static-svg", "icons");
const OUT = join(import.meta.dir, "..", "src", "components", "board", "harness-icons.ts");

const entries: string[] = [];
for (const [harness, icon] of Object.entries(LOCAL_ICONS)) {
  entries.push(
    `  // ${icon.source}\n  "${harness}": {\n    viewBox: "${icon.viewBox}",\n    paths: [\n${icon.paths
      .map((p) => `      "${p}",`)
      .join("\n")}\n    ],\n  },`,
  );
}
for (const [harness, icon] of Object.entries(ICONS)) {
  const svg = readFileSync(join(SRC, `${icon}.svg`), "utf8");
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "0 0 24 24";
  const paths = [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error(`no paths in ${icon}.svg`);
  entries.push(
    `  "${harness}": {\n    viewBox: "${viewBox}",\n    paths: [\n${paths
      .map((p) => `      "${p}",`)
      .join("\n")}\n    ],\n  },`,
  );
}

const version = JSON.parse(
  readFileSync(join(SRC, "..", "package.json"), "utf8"),
).version;

writeFileSync(
  OUT,
  `// GENERATED — do not edit. Regenerate with: bun dev/gen-harness-icons.ts
// Source: @lobehub/icons-static-svg@${version} (mono marks, currentColor).

export interface HarnessIcon {
  viewBox: string;
  paths: string[];
}

export const HARNESS_ICONS: Record<string, HarnessIcon> = {
${entries.join("\n")}
};
`,
);

console.log(`wrote ${OUT} (${Object.keys(ICONS).length} icons)`);
