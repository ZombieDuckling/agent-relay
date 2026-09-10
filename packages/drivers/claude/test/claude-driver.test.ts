import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ClaudeDriver } from "../src/claude-driver.js";

type ToolStep = { name: string; input: Record<string, unknown>; isError?: boolean };

/**
 * Models the real SDK harness shape: an `assistant` message carries ALL
 * tool_use blocks for a turn (streamed before any permission decision is
 * known), `canUseTool` is then invoked for each, and only the blocks that
 * were allowed get a corresponding `tool_result` in a later `user` message.
 * Denied blocks never get a `tool_result` at all.
 */
function fakeQuery(steps: Array<{ text?: string; tools?: ToolStep[] }>, result: any) {
  return ({ options }: any) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for (const step of steps) {
        const content: any[] = [];
        if (step.text) content.push({ type: "text", text: step.text });
        const toolIds = new Map<ToolStep, string>();
        if (step.tools) {
          for (let i = 0; i < step.tools.length; i++) {
            const t = step.tools[i]!;
            const id = `id-${i}-${t.name}`;
            toolIds.set(t, id);
            content.push({ type: "tool_use", id, name: t.name, input: t.input });
          }
        }
        yield { type: "assistant", message: { content }, session_id: "sess-1" };

        const decisions = new Map<ToolStep, "allow" | "deny">();
        if (step.tools && options.canUseTool) {
          for (const t of step.tools) {
            const d = await options.canUseTool(t.name, t.input, { signal: options.abortController.signal });
            decisions.set(t, d.behavior === "allow" ? "allow" : "deny");
          }
        }

        const resultContent = (step.tools ?? [])
          .filter((t) => decisions.get(t) === "allow")
          .map((t) => ({ type: "tool_result", tool_use_id: toolIds.get(t), is_error: t.isError ?? false }));
        if (resultContent.length) {
          yield { type: "user", message: { content: resultContent }, session_id: "sess-1" };
        }
      }
      yield result;
    })();
}

const okResult = { type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0, result: "done" };

test("maps SDK messages to DriverEvents: allowed write emits tool+artifact, denied read emits tool_denied only", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cd-"));
  const q = fakeQuery(
    [
      { text: "working" },
      {
        tools: [
          { name: "Write", input: { file_path: join(ws, "out.md") } },
          { name: "Read", input: { file_path: "/etc/hosts" } },
        ],
      },
    ],
    okResult,
  );
  const d = new ClaudeDriver({ query: q as any });
  const out: any[] = [];
  for await (const e of d.run({ workspace: ws, prompt: "p", signal: new AbortController().signal })) out.push(e);

  const types = out.map((e) => e.type);
  expect(types).toEqual(["init", "message", "tool", "artifact", "tool_denied", "result"]);
  expect(out[0]).toEqual({ type: "init", harness_session_id: "sess-1" });
  const denied = out.find((e) => e.type === "tool_denied");
  expect(denied.reason).toMatch(/outside workspace/);
  const artifact = out.find((e) => e.type === "artifact");
  expect(artifact).toEqual({ type: "artifact", path: "out.md" });
  expect(out.filter((e) => e.type === "tool")).toHaveLength(1);
  expect(out.filter((e) => e.type === "tool_denied")).toHaveLength(1);
  expect(out[out.length - 1]).toMatchObject({ type: "result", subtype: "success", num_turns: 2, duration_ms: 10, cost_usd: 0 });
});

test("a denied Write outside the workspace emits no artifact and exactly one tool_denied, no tool", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cd-"));
  const q = fakeQuery(
    [
      {
        tools: [{ name: "Write", input: { file_path: "/etc/pwned.txt" } }],
      },
    ],
    okResult,
  );
  const d = new ClaudeDriver({ query: q as any });
  const out: any[] = [];
  for await (const e of d.run({ workspace: ws, prompt: "p", signal: new AbortController().signal })) out.push(e);

  expect(out.filter((e) => e.type === "artifact")).toHaveLength(0);
  expect(out.filter((e) => e.type === "tool_denied")).toHaveLength(1);
  expect(out.filter((e) => e.type === "tool")).toHaveLength(0);
});
