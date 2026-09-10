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
  private allowBash: boolean;

  constructor(deps: { query?: typeof sdkQuery; model?: string; allowBash?: boolean } = {}) {
    this.q = deps.query ?? sdkQuery;
    this.model = deps.model;
    this.allowBash = deps.allowBash ?? false;
  }

  async *run(o: RunOptions): AsyncIterable<DriverEvent> {
    const abortController = new AbortController();
    o.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const pending: DriverEvent[] = [];
    // tool_use blocks observed in an `assistant` message, keyed by SDK id,
    // waiting either for a `canUseTool` denial or a matching `tool_result`.
    const buffered = new Map<string, { id: string; name: string; input: Record<string, unknown> }>();

    const options: Options = {
      cwd: o.workspace,
      resume: o.resume,
      abortController,
      permissionMode: "default",
      maxTurns: 25,
      ...(this.model ? { model: this.model } : {}),
      canUseTool: async (toolName, input) => {
        const d = decideToolUse(o.workspace, toolName, input, { allowBash: this.allowBash });
        if (d.allow) return { behavior: "allow", updatedInput: input };
        // Correlate the denial with a buffered tool_use block by name+input,
        // since canUseTool is not given the SDK's tool_use id.
        for (const [id, block] of buffered) {
          if (block.name === toolName && JSON.stringify(block.input) === JSON.stringify(input)) {
            buffered.delete(id);
            break;
          }
        }
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
              buffered.set(c.id, { id: c.id, name: c.name, input: c.input });
            }
          }
          break;
        }
        case "user": {
          const content = (m.message?.content ?? []) as Array<
            { type: "tool_result"; tool_use_id: string; is_error?: boolean } & Record<string, unknown>
          >;
          for (const c of content) {
            if (c.type !== "tool_result") continue;
            const block = buffered.get(c.tool_use_id);
            if (!block) continue;
            buffered.delete(c.tool_use_id);
            yield { type: "tool", name: block.name, input: block.input };
            const p = block.input?.file_path;
            if (WRITE_TOOLS.has(block.name) && typeof p === "string" && !c.is_error) {
              yield { type: "artifact", path: relative(o.workspace, p) };
            }
          }
          break;
        }
        case "result": {
          // Flush anything still buffered (e.g. no tool_result arrived) as a
          // plain `tool` event, with no artifact — we never observed the
          // effect, so we don't claim one happened.
          for (const block of buffered.values()) {
            yield { type: "tool", name: block.name, input: block.input };
          }
          buffered.clear();
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
