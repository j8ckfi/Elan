// The elan CLI — an agent's voice channel to the board. Runs inside a spawned
// session (the host puts a shim for it on the child's PATH); identity comes
// from env — ELAN_URL, ELAN_THREAD, ELAN_AGENT, ELAN_SESSION — so agents
// never pass it. Verbs translate 1:1 to host API calls; they mutate the board
// only — never git, files, or processes. See docs/ORCHESTRATION.md.

import { basename } from "node:path";
import type { BoardState, Post } from "../src/lib/board/types.ts";

const HELP = `elan — act on the Elan board from inside an agent session

  elan post <text…>                    top-level post; @handle mentions summon agents
  elan reply <post-id> <text…>         reply inside an exchange
  elan resolve <post-id> <text…>       file the ⚑ resolution that closes an exchange
  elan attach <path> [--note <text…>]  register an artifact (+ optional note post)
  elan thread                          print the rendered thread context
  elan read <post-id>                  print the full exchange containing a post
  elan help                            this table

Sessions stay hot: when your turn's work is done, just stop — new pings
(@mentions and replies to your posts) arrive as new messages in this same
session. If a ping needs nothing from you, post nothing. @handle mentions
SUMMON that agent — mention only to hand work off; narrate without the @.
(status/wake-me/wait are retired no-ops.)`;

function die(msg: string, code: number): never {
  console.error(msg);
  process.exit(code);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v)
    die(
      `elan: $${name} is not set. This CLI runs inside an Elan agent session — ` +
        `the host provides ELAN_URL, ELAN_THREAD, ELAN_AGENT and ELAN_SESSION.`,
      2,
    );
  return v;
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const base = need("ELAN_URL");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    die(`elan: cannot reach the host at ${base} (${String(e)})`, 1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    die(`elan: ${method} ${path} → ${res.status}${text ? ` ${text}` : ""}`, 1);
  }
  return res;
}

const ts = (ms: number): string =>
  new Date(ms).toISOString().replace("T", " ").slice(0, 19);

async function addPost(extra: Record<string, unknown>, text: string): Promise<void> {
  const res = await api("POST", "/api/posts", {
    threadId: need("ELAN_THREAD"),
    author: need("ELAN_AGENT"),
    body: text,
    ...extra,
  });
  const post = (await res.json()) as Post;
  console.log(`posted ${post.id}`);
}

const argv = process.argv.slice(2);
const verb = argv[0];
const rest = argv.slice(1);

switch (verb) {
  case undefined:
  case "help":
  case "--help":
  case "-h": {
    console.log(HELP);
    break;
  }

  case "post": {
    const text = rest.join(" ").trim();
    if (!text) die("usage: elan post <text…>", 1);
    await addPost({}, text);
    break;
  }

  case "reply":
  case "resolve": {
    const [postId, ...words] = rest;
    const text = words.join(" ").trim();
    if (!postId || !text) die(`usage: elan ${verb} <post-id> <text…>`, 1);
    await addPost(
      verb === "resolve" ? { replyTo: postId, kind: "resolution" } : { replyTo: postId },
      text,
    );
    break;
  }

  case "attach": {
    const noteIdx = rest.indexOf("--note");
    const note = noteIdx !== -1 ? rest.slice(noteIdx + 1).join(" ").trim() : undefined;
    const path = (noteIdx !== -1 ? rest.slice(0, noteIdx) : rest)[0];
    if (!path) die("usage: elan attach <path> [--note <text…>]", 1);
    const attachment = { name: basename(path), path };
    await api("POST", "/api/events", {
      threadId: need("ELAN_THREAD"),
      actor: need("ELAN_AGENT"),
      type: "artifact",
      payload: { attachment },
    });
    if (note) await addPost({ attachments: [attachment] }, note);
    console.log(`attached ${path}`);
    break;
  }

  case "status": {
    // Retired 2026-07-11 (thread statuses removed — they confused agents and
    // long-lived threads have no lifecycle): exit 0 so old habits don't error.
    console.log(
      "Thread statuses were removed — threads have no status to move. " +
        "Post your result instead (or nothing, if nothing was needed).",
    );
    break;
  }

  case "thread": {
    const res = await api(
      "GET",
      `/api/thread-context/${encodeURIComponent(need("ELAN_THREAD"))}` +
        `?handle=${encodeURIComponent(need("ELAN_AGENT"))}`,
    );
    console.log(await res.text());
    break;
  }

  case "read": {
    const postId = rest[0];
    if (!postId) die("usage: elan read <post-id>", 1);
    const state = (await (await api("GET", "/api/state")).json()) as BoardState;
    const target = state.posts.find((p) => p.id === postId);
    if (!target) die(`elan: no post ${postId}`, 1);
    const root = target.replyTo
      ? state.posts.find((p) => p.id === target.replyTo) ?? target
      : target;
    const replies = state.posts
      .filter((p) => p.replyTo === root.id)
      .sort((a, b) => a.createdAt - b.createdAt);
    const line = (p: Post, indent: string) =>
      `${indent}[${ts(p.createdAt)}] ${p.author}: ` +
      `${p.kind === "resolution" ? "⚑ " : ""}${p.body}` +
      p.attachments.map((a) => `\n${indent}  (attachment: ${a.path})`).join("");
    console.log(line(root, ""));
    for (const r of replies) console.log(line(r, "  "));
    break;
  }

  case "wake-me":
  case "wait": {
    // Retired with the hot-session model (docs/ORCHESTRATION.md "Wake-on-event
    // — removed"): exit 0 so old agent habits don't error.
    console.log(
      "Sessions stay hot — end your turn; new pings arrive as new turns.",
    );
    break;
  }

  default:
    die(`elan: unknown verb "${verb}"\n\n${HELP}`, 1);
}
