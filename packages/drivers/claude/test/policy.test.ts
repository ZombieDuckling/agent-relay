import { describe, expect, test } from "vitest";
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
  test("denies Bash that references paths outside workspace or home", () => {
    expect(decideToolUse(ws, "Bash", { command: "cat ~/.ssh/id_rsa" }).allow).toBe(false);
    expect(decideToolUse(ws, "Bash", { command: "ls /Users/x/.aws" }).allow).toBe(false);
    expect(decideToolUse(ws, "Bash", { command: "ls -la" })).toEqual({ allow: true });
  });
  test("denies network/web tools by default", () => {
    expect(decideToolUse(ws, "WebFetch", { url: "https://x" }).allow).toBe(false);
  });
  test("allows read-only search tools", () => {
    expect(decideToolUse(ws, "Glob", { pattern: "**/*.ts" })).toEqual({ allow: true });
  });
});
