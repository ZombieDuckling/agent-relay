export type DriverEvent =
  | { type: "init"; harness_session_id: string }
  | { type: "message"; role: "assistant" | "user"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_denied"; name: string; input: unknown; reason: string }
  | { type: "artifact"; path: string }
  | { type: "result"; subtype: "success" | "error" | "cancelled"; num_turns?: number; duration_ms?: number; cost_usd?: number; error?: string };

export type RunOptions = { workspace: string; prompt: string; resume?: string; signal: AbortSignal };

export interface Driver {
  readonly name: string;
  run(opts: RunOptions): AsyncIterable<DriverEvent>;
}
