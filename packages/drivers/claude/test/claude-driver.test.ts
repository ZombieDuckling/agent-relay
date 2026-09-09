import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ClaudeDriver } from "../src/claude-driver.js";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

function fakeQuery(steps: Array<{ text?: string; tools?: Array<{ name: string; input: Record<string, unknown> }> }>, result: any) {
  return ({ options }: any) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-1" };
      for (const step of steps) {
        const content: ContentBlock[] = [];
        if (step.text) content.push({ type: "text", text: step.text });
        if (step.tools) {
          for (const t of step.tools) {
            if (options.canUseTool) {
              const d = await options.canUseTool(t.name, t.input, { signal: options.abortController.signal });
              if (d.behavior === "deny") continue;
            }
            content.push({ type: "tool_use", id: `id-${t.name}`, name: t.name, input: t.input });
          }
        }
        yield { type: "assistant", message: { content }, session_id: "sess-1" };
      }
      yield result;
    })();
}

test("maps SDK messages to DriverEvents and denies out-of-workspace writes", async () => {
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
    { type: "result", subtype: "success", is_error: false, num_turns: 2, duration_ms: 10, total_cost_usd: 0, result: "done" },
  );
  const d = new ClaudeDriver({ query: q as any });
  const out: any[] = [];
  for await (const e of d.run({ workspace: ws, prompt: "p", signal: new AbortController().signal })) out.push(e);

  expect(out.map((e) => e.type)).toEqual(["init", "message", "tool", "artifact", "tool_denied", "result"]);
  expect(out[0]).toEqual({ type: "init", harness_session_id: "sess-1" });
  expect(out[3]).toEqual({ type: "artifact", path: "out.md" });
  expect(out[4].reason).toMatch(/outside workspace/);
  expect(out[5]).toMatchObject({ type: "result", subtype: "success", num_turns: 2, duration_ms: 10, cost_usd: 0 });
});
