import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "@agent-relay/core";
import { ClaudeDriver } from "../src/claude-driver.js";

test.skipIf(!process.env.CLAUDE_SMOKE)("session → run → artifact node + receipt", async () => {
  const m = new SessionManager({
    dataDir: mkdtempSync(join(tmpdir(), "e2e-")),
    templateDir: join(import.meta.dirname, "../../../../workbench-template"),
    drivers: { claude: new ClaudeDriver() },
  });
  const s = m.createSession("claude");
  for await (const _ of m.run(
    s.id,
    "Create hello.txt containing exactly: hello. Then you must call the Read tool on /etc/hosts and report what happens.",
  )) {
    // drain the run
  }
  expect(existsSync(join(s.workspace, "hello.txt"))).toBe(true);
  expect(m.graph.nodes("Artifact").some(n => n.id.endsWith("/hello.txt"))).toBe(true);
  expect(m.graph.nodes("ToolCall").some(n => n.props.denied === true)).toBe(true);
  expect(m.graph.nodes("Receipt")).toHaveLength(1);
}, 180_000);
