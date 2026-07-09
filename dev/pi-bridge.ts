// Dev-only WebSocket bridge: lets the browser build of Mari drive a real agent
// CLI. Each WebSocket connection spawns the command described by its `spec`
// query param (a JSON SpawnSpec: {bin, args, cwd} — see
// src/lib/agent/types.ts); stdout JSONL lines are forwarded verbatim to the
// socket, and socket messages are written to the child's stdin (one command
// per line). Run with:  bun dev/pi-bridge.ts
//
// The desktop build uses Tauri IPC instead and never touches this. The
// /sessions, /delete and /rename HTTP endpoints mirror the Rust core's
// Pi-session-store commands for browser dev.

import type { Subprocess } from "bun";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  encodeCwdDir,
  parseSessionMeta,
} from "../src/lib/adapters/pi/store-format.ts";
import type { SessionSummary } from "../src/lib/agent/types.ts";

const PORT = Number(process.env.PI_BRIDGE_PORT ?? 4317);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
} as const;

// Read + parse the on-disk session store. With a cwd, reads just that project's
// directory; without one, scans EVERY project dir so the sidebar can group all
// projects (each session carries its own cwd). Mirrors `pi_list_sessions`.
function listSessions(cwd?: string): SessionSummary[] {
  const base = join(homedir(), ".pi", "agent", "sessions");
  const dirs = cwd
    ? [join(base, encodeCwdDir(cwd))]
    : (() => {
        try {
          return readdirSync(base).map((d) => join(base, d));
        } catch {
          return [];
        }
      })();

  const out: SessionSummary[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      try {
        const meta = parseSessionMeta(
          readFileSync(path, "utf8"),
          path,
          statSync(path).mtimeMs,
        );
        if (meta) out.push(meta);
      } catch {
        /* skip unreadable/partial files */
      }
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Resolve a bare binary name: explicit paths pass through; otherwise prefer
 *  ~/.local/bin (where npm-global CLIs land) and fall back to PATH lookup. */
function resolveBin(bin: string): string {
  if (bin.includes("/")) return bin;
  const home = process.env.HOME ?? homedir();
  const local = join(home, ".local/bin", bin);
  if (existsSync(local)) return local;
  return bin;
}

interface Session {
  proc: Subprocess<"pipe", "pipe", "pipe">;
  buffer: string;
  /** Resolved working directory the child was spawned in (reported to the client). */
  cwd: string;
}

const server = Bun.serve<Session, undefined>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // ── Session listing (out-of-band from the RPC stream) ──────────────────
    if (url.pathname === "/sessions") {
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });
      // No cwd → list across all projects; a cwd narrows to one project.
      const cwd = url.searchParams.get("cwd") || undefined;
      return Response.json(listSessions(cwd), { headers: CORS });
    }

    // ── Delete / rename a saved session (mirrors pi_delete/rename_session) ──
    if (url.pathname === "/delete" || url.pathname === "/rename") {
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });
      const base = join(homedir(), ".pi", "agent", "sessions");
      const p = url.searchParams.get("path") || "";
      const ok = p.startsWith(base) && p.endsWith(".jsonl");
      if (!ok) return new Response("bad path", { status: 400, headers: CORS });
      try {
        if (url.pathname === "/delete") {
          require("node:fs").unlinkSync(p);
        } else {
          const name = url.searchParams.get("name") || "";
          const line = JSON.stringify({ type: "session_info", name }) + "\n";
          require("node:fs").appendFileSync(p, line);
        }
        return new Response(null, { status: 204, headers: CORS });
      } catch (e) {
        return new Response(String(e), { status: 500, headers: CORS });
      }
    }

    // ── Spawn the agent CLI this socket will own ────────────────────────────
    let spec: { bin?: string; args?: string[]; cwd?: string } = {};
    try {
      spec = JSON.parse(url.searchParams.get("spec") ?? "{}");
    } catch {
      return new Response("pi-bridge: malformed spec param", { status: 400 });
    }
    const bin = resolveBin(spec.bin || "pi");
    const args = spec.args ?? [];

    const resolvedCwd = spec.cwd || process.env.HOME || homedir();
    const proc = Bun.spawn([bin, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: resolvedCwd,
    });

    if (server.upgrade(req, { data: { proc, buffer: "", cwd: resolvedCwd } }))
      return;
    proc.kill();
    return new Response("pi-bridge: expected a WebSocket upgrade", {
      status: 426,
    });
  },
  websocket: {
    open(ws) {
      const { proc } = ws.data;
      console.log(`[bridge] agent spawned (pid ${proc.pid}) in ${ws.data.cwd}`);
      // Report the working directory up front — some CLIs never state it, but
      // the breadcrumb needs the real project path (not a fallback).
      try {
        ws.send(JSON.stringify({ type: "cwd", cwd: ws.data.cwd }));
      } catch {
        /* socket already closed */
      }

      // stdout → socket, strict LF framing.
      (async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            ws.data.buffer += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = ws.data.buffer.indexOf("\n")) !== -1) {
              let line = ws.data.buffer.slice(0, nl);
              ws.data.buffer = ws.data.buffer.slice(nl + 1);
              if (line.endsWith("\r")) line = line.slice(0, -1);
              if (line.length > 0) {
                try {
                  ws.send(line);
                } catch {
                  return;
                }
              }
            }
          }
        } catch {
          /* stream closed */
        } finally {
          try {
            ws.close();
          } catch {
            /* already closed */
          }
        }
      })();

      // stderr → server log only (not protocol-valid JSON).
      (async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true }).trimEnd();
          if (text) console.error(`[pi:stderr] ${text}`);
        }
      })();
    },
    message(ws, message) {
      const line = typeof message === "string" ? message : message.toString();
      try {
        ws.data.proc.stdin.write(line + "\n");
        ws.data.proc.stdin.flush();
      } catch (e) {
        console.error("[bridge] write failed", e);
      }
    },
    close(ws) {
      console.log(
        `[bridge] socket closed, killing agent (pid ${ws.data.proc.pid})`,
      );
      try {
        ws.data.proc.kill();
      } catch {
        /* already dead */
      }
    },
  },
});

console.log(`[bridge] pi-bridge listening on ws://localhost:${server.port}`);
