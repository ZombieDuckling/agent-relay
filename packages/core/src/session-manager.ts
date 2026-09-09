import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventLog } from "./event-log.js";
import { SessionGraph } from "./graph.js";
import { createWorkspace } from "./workspace.js";
import type { Driver } from "./driver.js";
import type { RelayEvent } from "./events.js";

export type SessionManagerOptions = { dataDir: string; templateDir: string; drivers: Record<string, Driver> };
type SessionState = { driver: string; workspace: string; runs: number; harnessSessionId?: string; abort?: AbortController };

export class SessionManager {
  readonly graph: SessionGraph;
  private log: EventLog;
  private sessions = new Map<string, SessionState>();

  constructor(private o: SessionManagerOptions) {
    mkdirSync(join(o.dataDir, "workspaces"), { recursive: true });
    this.log = new EventLog(join(o.dataDir, "events.jsonl"));
    this.graph = new SessionGraph(join(o.dataDir, "graph.db"));
    this.graph.rebuild(this.log.readAll());
  }

  private record(e: Omit<RelayEvent, "id" | "ts">): RelayEvent {
    const full = this.log.append(e);
    this.graph.apply(full);
    return full;
  }

  createSession(driverName: string) {
    if (!this.o.drivers[driverName]) throw new Error(`unknown driver: ${driverName}`);
    const id = randomUUID().slice(0, 8);
    const workspace = createWorkspace(join(this.o.dataDir, "workspaces"), id, this.o.templateDir);
    this.sessions.set(id, { driver: driverName, workspace, runs: 0 });
    this.record({ session_id: id, kind: "session.created", data: { driver: driverName, workspace } });
    return { id, workspace };
  }

  async *run(sid: string, prompt: string): AsyncIterable<RelayEvent> {
    const s = this.sessions.get(sid);
    if (!s) throw new Error(`unknown session: ${sid}`);
    const driver = this.o.drivers[s.driver]!;
    const run = s.runs++;
    s.abort = new AbortController();
    yield this.record({ session_id: sid, run, kind: "run.started",
      data: { prompt, ...(run > 0 ? { resumed_from: String(run - 1) } : {}) } });
    let msg = 0, tool = 0;
    for await (const ev of driver.run({ workspace: s.workspace, prompt, resume: s.harnessSessionId, signal: s.abort.signal })) {
      switch (ev.type) {
        case "init": s.harnessSessionId = ev.harness_session_id; break;
        case "message": yield this.record({ session_id: sid, run, kind: "message", data: { index: msg++, role: ev.role, text: ev.text } }); break;
        case "tool": yield this.record({ session_id: sid, run, kind: "tool.called", data: { index: tool++, name: ev.name, input: ev.input } }); break;
        case "tool_denied": yield this.record({ session_id: sid, run, kind: "tool.denied", data: { index: tool++, name: ev.name, input: ev.input, reason: ev.reason } }); break;
        case "artifact": yield this.record({ session_id: sid, run, kind: "artifact.written", data: { path: ev.path } }); break;
        case "result": {
          const { type: _t, ...rest } = ev;
          yield this.record({ session_id: sid, run, kind: "run.finished", data: rest });
          break;
        }
      }
    }
  }

  cancel(sid: string) {
    const s = this.sessions.get(sid);
    if (!s) return;
    s.abort?.abort();
    this.record({ session_id: sid, kind: "session.cancelled", data: {} });
  }

  events(sid: string) { return this.log.readSession(sid); }
}
