// Pi RPC wire protocol — transcribed from the pi-coding-agent docs/rpc.md.
// Kept pragmatic: the shapes the adapter actually reads are precise; the rest
// is permissive so protocol additions don't break parsing.
//
// Nothing outside src/lib/adapters/pi/ may import this file — the UI only sees
// the neutral contract in src/lib/agent/types.ts.

import type { Model, ThinkingLevel } from "@/lib/agent/types";

// ─── Message content blocks ──────────────────────────────────────────────────
export interface TextContent {
  type: "text";
  text: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}
export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: unknown;
}
export type AssistantContent = TextContent | ThinkingContent | ToolCallContent;

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: unknown;
  stopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp?: number;
}

export interface UserMessage {
  role: "user";
  content: string | Array<TextContent | ImageContent>;
  timestamp?: number;
  attachments?: unknown[];
}

export interface ToolResultBlock {
  type: "text";
  text: string;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ToolResultBlock[];
  isError?: boolean;
  timestamp?: number;
}

export type AgentMessage =
  | AssistantMessage
  | UserMessage
  | ToolResultMessage
  | { role: string; [k: string]: unknown };

// ─── Tool execution result payload ───────────────────────────────────────────
export interface ToolResult {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  details?: {
    patch?: string;
    diff?: string;
    [k: string]: unknown;
  };
}

// ─── Events (stdout lines) ───────────────────────────────────────────────────
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: AssistantMessage; toolResults?: unknown[] }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AssistantMessage;
      assistantMessageEvent: unknown;
    }
  | { type: "message_end"; message: AgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: ToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: ToolResult;
      isError: boolean;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | {
      type: "compaction_end";
      reason: string;
      result: unknown;
      aborted: boolean;
      willRetry?: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | {
      type: "auto_retry_end";
      success: boolean;
      attempt: number;
      finalError?: string;
    }
  | {
      type: "extension_error";
      extensionPath: string;
      event: string;
      error: string;
    }
  | ExtensionUiRequest
  | RpcResponse
  // Synthetic host line: the resolved working directory of the spawned child.
  | { type: "cwd"; cwd?: string };

// ─── Extension UI sub-protocol ───────────────────────────────────────────────
export type ExtensionUiRequest = {
  type: "extension_ui_request";
  id: string;
} & (
  | { method: "select"; title: string; options: string[]; timeout?: number }
  | {
      method: "confirm";
      title: string;
      message?: string;
      timeout?: number;
    }
  | { method: "input"; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title: string; prefill?: string; timeout?: number }
  | {
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | { method: "setStatus"; statusKey: string; statusText?: string }
  | {
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
);

export type ExtensionUiResponse = {
  type: "extension_ui_response";
  id: string;
} & (
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
);

// ─── Command responses ───────────────────────────────────────────────────────
export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

// ─── Outgoing commands (subset we use) ───────────────────────────────────────
export type StreamingBehavior = "steer" | "followUp";

export type PiCommand =
  | {
      id?: string;
      type: "prompt";
      message: string;
      images?: ImageContent[];
      streamingBehavior?: StreamingBehavior;
    }
  | { id?: string; type: "steer"; message: string; images?: ImageContent[] }
  | { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
  | { id?: string; type: "abort" }
  | { id?: string; type: "new_session"; parentSession?: string }
  | { id?: string; type: "get_state" }
  | { id?: string; type: "get_messages" }
  | { id?: string; type: "get_available_models" }
  | { id?: string; type: "set_model"; provider: string; modelId: string }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "set_session_name"; name: string }
  | ExtensionUiResponse;

/** get_state response data (fields we read). */
export interface GetStateData {
  model?: Model;
  thinkingLevel?: ThinkingLevel;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  cwd?: string;
}
