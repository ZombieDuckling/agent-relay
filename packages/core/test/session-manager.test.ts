import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { FakeDriver } from "../src/fake-driver.js";
import type { Driver, DriverEvent, RunOptions } from "../src/driver.js";

class ThrowingDriver implements Driver {
  readonly name = "throwing";
  async *run(_opts: RunOptions): AsyncIterable<DriverEvent> {
    yield { type: "init", harness_session_id: "h1" };
    yield { type: "message", role: "assistant", text: "hi" };
    throw new Error("boom");
  }
}

class AbortAwareDriver implements Driver {
  readonly name = "abort-aware";
  async *run(opts: RunOptions): AsyncIterable<DriverEvent> {
    yield { type: "init", harness_session_id: "h1" };
    await new Promise<void>((_, rej) => {
      opts.signal.addEventListener("abort", () => rej(new Error("aborted")));
    });
  }
}

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

test("driver error still records a terminal run.finished event", async () => {
  const m = new SessionManager({
    dataDir: mkdtempSync(join(tmpdir(), "relay-")),
    templateDir: join(import.meta.dirname, "../../../workbench-template"),
    drivers: { throwing: new ThrowingDriver() },
  });
  const s = m.createSession("throwing");
  await expect((async () => {
    for await (const _ of m.run(s.id, "go")) { /* drain */ }
  })()).rejects.toThrow(/boom/);

  const events = m.events(s.id);
  const finished = events.find(e => e.kind === "run.finished");
  expect(finished).toBeDefined();
  expect((finished!.data as any).subtype).toBe("error");
  expect((finished!.data as any).error).toMatch(/boom/);
  expect(m.graph.nodes("Receipt")).toHaveLength(1);
});

test("cancel during a run records a terminal run.finished with subtype cancelled", async () => {
  const m = new SessionManager({
    dataDir: mkdtempSync(join(tmpdir(), "relay-")),
    templateDir: join(import.meta.dirname, "../../../workbench-template"),
    drivers: { "abort-aware": new AbortAwareDriver() },
  });
  const s = m.createSession("abort-aware");
  const iteration = (async () => {
    for await (const _ of m.run(s.id, "go")) { /* drain */ }
  })();
  const failure = expect(iteration).rejects.toThrow(/aborted/);
  // Let the driver's async generator reach its abort-listener registration
  // before we trigger cancel(), otherwise the abort fires before anyone is listening.
  await new Promise(resolve => setTimeout(resolve, 0));
  m.cancel(s.id);
  await failure;

  const events = m.events(s.id);
  const finished = events.find(e => e.kind === "run.finished");
  expect(finished).toBeDefined();
  expect((finished!.data as any).subtype).toBe("cancelled");
});
