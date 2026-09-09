import { relative } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Driver, DriverEvent, RunOptions } from "@agent-relay/core";
import { decideToolUse } from "./policy.js";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

type ContentBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export class ClaudeDriver implements Driver {
  readonly name = "claude";
  private q: typeof sdkQuery;
  private model?: string;

  constructor(deps: { query?: typeof sdkQuery; model?: string } = {}) {
    this.q = deps.query ?? sdkQuery;
    this.model = deps.model;
  }

  async *run(o: RunOptions): AsyncIterable<DriverEvent> {
    const abortController = new AbortController();
    o.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const pending: DriverEvent[] = [];

    const options: Options = {
      cwd: o.workspace,
      resume: o.resume,
      abortController,
      permissionMode: "default",
      maxTurns: 25,
      ...(this.model ? { model: this.model } : {}),
      canUseTool: async (toolName, input) => {
        const d = decideToolUse(o.workspace, toolName, input);
        if (d.allow) return { behavior: "allow", updatedInput: input };
        pending.push({ type: "tool_denied", name: toolName, input, reason: d.reason });
        return { behavior: "deny", message: d.reason };
      },
    };

    const stream = this.q({ prompt: o.prompt, options });

    for await (const m of stream as AsyncIterable<SDKMessage>) {
      switch (m.type) {
        case "system": {
          if (m.subtype === "init") yield { type: "init", harness_session_id: m.session_id };
          break;
        }
        case "assistant": {
          const content = (m.message?.content ?? []) as ContentBlock[];
          for (const c of content) {
            if (c.type === "text" && c.text) {
              yield { type: "message", role: "assistant", text: c.text };
            } else if (c.type === "tool_use") {
              yield { type: "tool", name: c.name, input: c.input };
              const p = (c.input as Record<string, unknown> | undefined)?.file_path;
              if (WRITE_TOOLS.has(c.name) && typeof p === "string") {
                yield { type: "artifact", path: relative(o.workspace, p) };
              }
            }
          }
          break;
        }
        case "result": {
          while (pending.length) yield pending.shift()!;
          const isError = m.is_error;
          const subtype: "success" | "error" | "cancelled" = abortController.signal.aborted
            ? "cancelled"
            : m.subtype === "success" && !isError
              ? "success"
              : "error";
          yield {
            type: "result",
            subtype,
            num_turns: m.num_turns,
            duration_ms: m.duration_ms,
            cost_usd: m.total_cost_usd,
            error: subtype === "error" ? (("errors" in m && m.errors?.join("; ")) || m.subtype) : undefined,
          };
          break;
        }
        default:
          break;
      }
      while (pending.length) yield pending.shift()!;
    }
    while (pending.length) yield pending.shift()!;
  }
}
