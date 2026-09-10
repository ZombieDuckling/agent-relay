import { describe, expect, test } from "vitest";
import { SessionGraph } from "../src/graph.js";
import type { RelayEvent } from "../src/events.js";

const ev = (id: string, kind: RelayEvent["kind"], data: Record<string, unknown>, run?: number): RelayEvent =>
  ({ id: `evt_${id}`, ts: "2026-09-09T00:00:00.000Z", session_id: "s1", kind, data, run });

const events: RelayEvent[] = [
  ev("1", "session.created", { driver: "fake", workspace: "/w/s1" }),
  ev("2", "run.started", { prompt: "hi" }, 0),
  ev("3", "tool.called", { name: "Write", input: { file_path: "/w/s1/a.txt" }, index: 0 }, 0),
  ev("4", "artifact.written", { path: "a.txt" }, 0),
  ev("5", "run.finished", { subtype: "success", num_turns: 1, duration_ms: 5 }, 0),
];

describe("SessionGraph", () => {
  test("projects events into typed nodes and provenance edges", () => {
    const g = new SessionGraph(":memory:");
    g.rebuild(events);
    expect(g.nodes("Session").map(n => n.id)).toEqual(["session/s1"]);
    expect(g.nodes("Run").map(n => n.id)).toEqual(["session/s1/run/0"]);
    expect(g.nodes("Artifact").map(n => n.id)).toEqual(["artifact/s1/a.txt"]);
    const e = g.edges("HAS_RUN")[0];
    expect(e).toMatchObject({ from: "session/s1", to: "session/s1/run/0", source_event_id: "evt_2" });
    expect(g.edges("EXECUTED_BY")[0]).toMatchObject({ from: "session/s1", to: "driver/fake" });
    expect(g.edges("RECEIPTED_BY")[0].to).toBe("session/s1/run/0/receipt");
  });
  test("rebuild is deterministic and idempotent", () => {
    const a = new SessionGraph(":memory:"); a.rebuild(events);
    const b = new SessionGraph(":memory:"); b.rebuild(events); b.rebuild(events);
    expect(b.snapshot()).toEqual(a.snapshot());
  });
  test("upsertNode merges props: session.cancelled keeps created_at and adds cancelled_at", () => {
    const g = new SessionGraph(":memory:");
    g.rebuild(events);
    g.apply(ev("6", "session.cancelled", {}));
    const session = g.nodes("Session").find(n => n.id === "session/s1")!;
    expect(session.props.created_at).toBeDefined();
    expect(session.props.cancelled_at).toBeDefined();
  });
  test("neighbors traverses both directions", () => {
    const g = new SessionGraph(":memory:"); g.rebuild(events);
    const ids = g.neighbors("session/s1/run/0").map(n => n.id).sort();
    expect(ids).toEqual(["session/s1", "session/s1/run/0/receipt", "session/s1/run/0/tool/0"]);
  });
});
