import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ClaudeDriver } from "../src/claude-driver.js";

test.skipIf(!process.env.CLAUDE_SMOKE)("real Claude Code writes a file inside the workspace", async () => {
  const ws = mkdtempSync(join(tmpdir(), "smoke-"));
  const d = new ClaudeDriver();
  const events: any[] = [];
  for await (const e of d.run({ workspace: ws, prompt: "Create a file named hello.txt containing exactly: hello", signal: new AbortController().signal })) events.push(e);
  expect(events.at(-1)?.type).toBe("result");
  expect(existsSync(join(ws, "hello.txt"))).toBe(true);
}, 120_000);
