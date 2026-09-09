import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorkspace } from "../src/workspace.js";
import { FakeDriver } from "../src/fake-driver.js";

test("createWorkspace copies template and stamps session id", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const tpl = join(import.meta.dirname, "../../../workbench-template");
  const ws = createWorkspace(root, "abc", tpl);
  expect(ws).toBe(join(root, "abc"));
  expect(existsSync(join(ws, "REQUEST.md"))).toBe(true);
  expect(readFileSync(join(ws, "STATUS.md"), "utf8")).toContain("abc");
});

test("FakeDriver writes a file and emits the canonical event sequence", async () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  const d = new FakeDriver();
  const types: string[] = [];
  for await (const e of d.run({ workspace: root, prompt: "write hello.txt", signal: new AbortController().signal })) types.push(e.type);
  expect(types).toEqual(["init", "message", "tool", "artifact", "result"]);
  expect(readFileSync(join(root, "hello.txt"), "utf8")).toBe("hello\n");
});
