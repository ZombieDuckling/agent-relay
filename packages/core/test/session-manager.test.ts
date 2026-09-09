import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { FakeDriver } from "../src/fake-driver.js";

const mk = () => new SessionManager({
  dataDir: mkdtempSync(join(tmpdir(), "relay-")),
  templateDir: join(import.meta.dirname, "../../../workbench-template"),
  drivers: { fake: new FakeDriver() },
});

test("run persists events and projects graph", async () => {
  const m = mk();
  const s = m.createSession("fake");
  const kinds: string[] = [];
  for await (const e of m.run(s.id, "write hello.txt")) kinds.push(e.kind);
  expect(kinds).toEqual(["run.started", "message", "tool.called", "artifact.written", "run.finished"]);
  expect(m.graph.nodes("Artifact")[0].id).toBe(`artifact/${s.id}/hello.txt`);
  expect(m.graph.edges("EXECUTED_BY")[0].to).toBe("driver/fake");
});

test("second run increments run index and RESUMED_FROM links it", async () => {
  const m = mk();
  const s = m.createSession("fake");
  for await (const _ of m.run(s.id, "a")) {}
  for await (const _ of m.run(s.id, "b")) {}
  expect(m.graph.nodes("Run").map(n => n.id)).toEqual([`session/${s.id}/run/0`, `session/${s.id}/run/1`]);
  expect(m.graph.edges("RESUMED_FROM")).toHaveLength(1);
});

test("unknown driver throws", () => {
  expect(() => mk().createSession("nope")).toThrow(/unknown driver/);
});
