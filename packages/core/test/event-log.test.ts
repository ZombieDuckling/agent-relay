import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EventLog } from "../src/event-log.js";

describe("EventLog", () => {
  test("append assigns id+ts and readSession filters", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    const log = new EventLog(join(dir, "events.jsonl"));
    const a = log.append({ session_id: "s1", kind: "session.created", data: { driver: "fake" } });
    log.append({ session_id: "s2", kind: "session.created", data: {} });
    expect(a.id).toMatch(/^evt_/);
    expect(Date.parse(a.ts)).not.toBeNaN();
    expect(log.readAll()).toHaveLength(2);
    expect(log.readSession("s1").map(e => e.id)).toEqual([a.id]);
  });
  test("rejects invalid kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-"));
    const log = new EventLog(join(dir, "events.jsonl"));
    // @ts-expect-error invalid kind
    expect(() => log.append({ session_id: "s", kind: "nope", data: {} })).toThrow();
  });
});
