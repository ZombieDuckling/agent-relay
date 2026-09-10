import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideToolUse } from "../src/policy.js";

const ws = "/tmp/ws/abc";

describe("decideToolUse", () => {
  test("allows file tools inside workspace", () => {
    expect(decideToolUse(ws, "Write", { file_path: `${ws}/a.txt` })).toEqual({ allow: true });
    expect(decideToolUse(ws, "Read", { file_path: `${ws}/sub/../b.txt` })).toEqual({ allow: true });
  });

  test("denies file tools outside workspace incl. traversal", () => {
    expect(decideToolUse(ws, "Read", { file_path: "/etc/passwd" }).allow).toBe(false);
    expect(decideToolUse(ws, "Edit", { file_path: `${ws}/../../x` }).allow).toBe(false);
  });

  test("denies Bash by default", () => {
    expect(decideToolUse(ws, "Bash", { command: "ls -la" })).toEqual({
      allow: false,
      reason: "Bash disabled by relay policy (set allowBash)",
    });
  });

  test("denies Bash that references paths outside workspace or home, when allowed", () => {
    expect(decideToolUse(ws, "Bash", { command: "cat ~/.ssh/id_rsa" }, { allowBash: true }).allow).toBe(false);
    expect(decideToolUse(ws, "Bash", { command: "ls /Users/x/.aws" }, { allowBash: true }).allow).toBe(false);
    expect(decideToolUse(ws, "Bash", { command: "ls -la" }, { allowBash: true })).toEqual({ allow: true });
  });

  test("denies Bash with command substitution even when allowBash is true", () => {
    expect(decideToolUse(ws, "Bash", { command: "echo $(id)" }, { allowBash: true }).allow).toBe(false);
  });

  test("denies network/web tools by default", () => {
    expect(decideToolUse(ws, "WebFetch", { url: "https://x" }).allow).toBe(false);
    expect(decideToolUse(ws, "WebSearch", { query: "x" }).allow).toBe(false);
  });

  test("allows read-only search tools", () => {
    expect(decideToolUse(ws, "Glob", { pattern: "**/*.ts" })).toEqual({ allow: true });
  });

  test("denies Grep with path outside workspace", () => {
    const result = decideToolUse(ws, "Grep", { pattern: ".", path: "/etc", output_mode: "content" });
    expect(result.allow).toBe(false);
  });

  test("allows Grep with no path", () => {
    expect(decideToolUse(ws, "Grep", { pattern: "." })).toEqual({ allow: true });
  });

  test("allows Glob with path inside workspace", () => {
    expect(decideToolUse(ws, "Glob", { pattern: "**/*.ts", path: `${ws}/sub` })).toEqual({ allow: true });
  });

  test("denies LS with path outside workspace", () => {
    const result = decideToolUse(ws, "LS", { path: "/etc" });
    expect(result.allow).toBe(false);
  });

  test("denies Task", () => {
    expect(decideToolUse(ws, "Task", {})).toEqual({
      allow: false,
      reason: "tool not in relay allowlist: Task",
    });
  });

  test("denies unknown tool by default (default-deny)", () => {
    expect(decideToolUse(ws, "FooTool", {})).toEqual({
      allow: false,
      reason: "tool not in relay allowlist: FooTool",
    });
  });

  test("denies empty or missing file_path", () => {
    expect(decideToolUse(ws, "Read", { file_path: "" })).toEqual({ allow: false, reason: "missing file_path" });
    expect(decideToolUse(ws, "Read", {})).toEqual({ allow: false, reason: "missing file_path" });
    expect(decideToolUse(ws, "Read", { file_path: 42 })).toEqual({ allow: false, reason: "missing file_path" });
  });

  describe("symlink escape", () => {
    const realWorkspaceRoot = mkdtempSync(join(tmpdir(), "policy-ws-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "policy-outside-"));
    const workspace = join(realWorkspaceRoot, "ws");
    mkdirSync(workspace);
    const linkPath = join(workspace, "link");
    symlinkSync(outsideDir, linkPath);

    test("denies Read through a symlink that escapes the workspace", () => {
      const target = join(linkPath, "x");
      const result = decideToolUse(workspace, "Read", { file_path: target });
      expect(result.allow).toBe(false);
    });

    test("denies a new file created under a symlinked directory that escapes the workspace", () => {
      // File does not exist yet, but its parent dir (the symlink) does.
      const target = join(linkPath, "new-file-does-not-exist.txt");
      const result = decideToolUse(workspace, "Write", { file_path: target });
      expect(result.allow).toBe(false);
    });

    test("still allows real files inside the workspace", () => {
      const target = join(workspace, "real.txt");
      const result = decideToolUse(workspace, "Write", { file_path: target });
      expect(result).toEqual({ allow: true });
    });
  });
});
