// Pi RPC protocol types — transcribed from the pi-coding-agent docs/rpc.md.
// Kept pragmatic: the shapes the reducer/UI actually read are precise; the
// rest is permissive so protocol additions don't break parsing.

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
}

// ─── Message content blocks ────────────────────────────────────────────────
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

// ─── Streaming delta (message_update.assistantMessageEvent) ─────────────────
export type AssistantDelta =
  | { type: "start"; partial?: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial?: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial?: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content?: string;
      partial?: AssistantMessage;
    }
  | { type: "thinking_start"; contentIndex: number; partial?: AssistantMessage }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial?: AssistantMessage;
    }
  | { type: "thinking_end"; contentIndex: number; partial?: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial?: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta?: string }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall?: ToolCallContent;
      partial?: AssistantMessage;
    }
  | { type: "done"; reason?: "stop" | "length" | "toolUse" }
  | { type: "error"; reason?: "aborted" | "error"; message?: string };

// ─── Tool execution result payload ─────────────────────────────────────────
export interface ToolResult {
  content: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  details?: {
    patch?: string;
    diff?: string;
    [k: string]: unknown;
  };
}

// ─── Events (from stdout `pi://event`) ─────────────────────────────────────
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages?: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message?: AssistantMessage; toolResults?: unknown[] }
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AssistantMessage;
      assistantMessageEvent: AssistantDelta;
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
  | RpcResponse;

// ─── Extension UI sub-protocol ─────────────────────────────────────────────
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

/** Dialog methods that block waiting for an extension_ui_response. */
export type ExtensionUiDialogMethod = "select" | "confirm" | "input" | "editor";

export type ExtensionUiResponse = {
  type: "extension_ui_response";
  id: string;
} & (
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
);

// ─── Command responses ─────────────────────────────────────────────────────
export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

// ─── Outgoing commands (subset we use) ─────────────────────────────────────
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
  | { id?: string; type: "cycle_model" }
  | { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
  | { id?: string; type: "cycle_thinking_level" }
  | { id?: string; type: "get_session_stats" }
  | { id?: string; type: "compact"; customInstructions?: string }
  | { id?: string; type: "get_commands" }
  | { id?: string; type: "switch_session"; sessionPath: string }
  | { id?: string; type: "fork"; entryId: string }
  | { id?: string; type: "get_fork_messages" }
  | { id?: string; type: "set_session_name"; name: string }
  | ExtensionUiResponse;

// ─── Session stats (get_session_stats response.data) ───────────────────────
export interface SessionStats {
  sessionFile?: string;
  sessionId?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost?: number;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}
