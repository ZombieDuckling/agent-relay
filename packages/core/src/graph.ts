import Database from "better-sqlite3";
import type { RelayEvent } from "./events.js";

export type NodeType = "Session"|"Run"|"Message"|"ToolCall"|"Artifact"|"ContextInjection"|"Driver"|"Workspace"|"Receipt";
export type EdgeType = "HAS_RUN"|"PRODUCED"|"CALLED"|"WROTE"|"INJECTED_INTO"|"RESUMED_FROM"|"EXECUTED_BY"|"RECEIPTED_BY";
export type GraphNode = { id: string; type: NodeType; props: Record<string, unknown> };
export type GraphEdge = { from: string; to: string; type: EdgeType; ts: string; source_event_id: string };

type NodeRow = { id: string; type: string; props: string };
type EdgeRow = { from: string; to: string; type: string; ts: string; source_event_id: string };

export class SessionGraph {
  private db: Database.Database;
  private lastTool = new Map<string, string>();
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, type TEXT NOT NULL, props TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edges (
        "from" TEXT NOT NULL, "to" TEXT NOT NULL, type TEXT NOT NULL, ts TEXT NOT NULL, source_event_id TEXT NOT NULL,
        PRIMARY KEY ("from","to",type,source_event_id));
    `);
  }

  private upsertNode(n: GraphNode) {
    const existing = this.db.prepare("SELECT props FROM nodes WHERE id=?").get(n.id) as { props: string } | undefined;
    const props = existing ? { ...JSON.parse(existing.props), ...n.props } : n.props;
    this.db.prepare("INSERT OR REPLACE INTO nodes(id,type,props) VALUES(?,?,?)").run(n.id, n.type, JSON.stringify(props));
  }
  private addEdge(e: GraphEdge) {
    this.db.prepare('INSERT OR IGNORE INTO edges("from","to",type,ts,source_event_id) VALUES(?,?,?,?,?)')
      .run(e.from, e.to, e.type, e.ts, e.source_event_id);
  }

  apply(e: RelayEvent): void {
    const sid = `session/${e.session_id}`;
    const run = e.run !== undefined ? `${sid}/run/${e.run}` : undefined;
    const prov = { ts: e.ts, source_event_id: e.id };
    switch (e.kind) {
      case "session.created": {
        const driver = String(e.data.driver ?? "unknown");
        this.upsertNode({ id: sid, type: "Session", props: { created_at: e.ts } });
        this.upsertNode({ id: `driver/${driver}`, type: "Driver", props: {} });
        this.addEdge({ from: sid, to: `driver/${driver}`, type: "EXECUTED_BY", ...prov });
        if (e.data.workspace) {
          this.upsertNode({ id: `workspace/${e.session_id}`, type: "Workspace", props: { path: e.data.workspace } });
          this.addEdge({ from: sid, to: `workspace/${e.session_id}`, type: "PRODUCED", ...prov });
        }
        break;
      }
      case "run.started": {
        if (!run) return;
        this.upsertNode({ id: run, type: "Run", props: { prompt: e.data.prompt, started_at: e.ts } });
        this.addEdge({ from: sid, to: run, type: "HAS_RUN", ...prov });
        if (typeof e.data.resumed_from === "string")
          this.addEdge({ from: run, to: `${sid}/run/${e.data.resumed_from}`, type: "RESUMED_FROM", ...prov });
        break;
      }
      case "message": {
        if (!run) return;
        const id = `${run}/msg/${e.data.index}`;
        this.upsertNode({ id, type: "Message", props: { role: e.data.role, text: e.data.text } });
        this.addEdge({ from: run, to: id, type: "PRODUCED", ...prov });
        break;
      }
      case "tool.called":
      case "tool.denied": {
        if (!run) return;
        const id = `${run}/tool/${e.data.index}`;
        this.upsertNode({ id, type: "ToolCall", props: { name: e.data.name, input: e.data.input, denied: e.kind === "tool.denied", reason: e.data.reason } });
        this.addEdge({ from: run, to: id, type: "CALLED", ...prov });
        this.lastTool.set(run, id);
        break;
      }
      case "artifact.written": {
        if (!run) return;
        const id = `artifact/${e.session_id}/${e.data.path}`;
        this.upsertNode({ id, type: "Artifact", props: { path: e.data.path } });
        const writer = this.lastTool.get(run) ?? run;
        this.addEdge({ from: writer, to: id, type: "WROTE", ...prov });
        break;
      }
      case "context.injected": {
        const id = `${sid}/context/${e.data.index}`;
        this.upsertNode({ id, type: "ContextInjection", props: { text: e.data.text } });
        this.addEdge({ from: id, to: sid, type: "INJECTED_INTO", ...prov });
        break;
      }
      case "run.finished": {
        if (!run) return;
        const id = `${run}/receipt`;
        this.upsertNode({ id, type: "Receipt", props: { ...e.data, finished_at: e.ts } });
        this.addEdge({ from: run, to: id, type: "RECEIPTED_BY", ...prov });
        break;
      }
      case "session.cancelled":
        this.upsertNode({ id: sid, type: "Session", props: { cancelled_at: e.ts } });
        break;
    }
  }

  rebuild(events: RelayEvent[]): void {
    this.db.exec("DELETE FROM edges; DELETE FROM nodes;");
    this.lastTool.clear();
    const tx = this.db.transaction((evs: RelayEvent[]) => { for (const e of evs) this.apply(e); });
    tx(events);
  }

  nodes(type?: NodeType): GraphNode[] {
    const rows = (type
      ? this.db.prepare("SELECT * FROM nodes WHERE type=? ORDER BY id").all(type)
      : this.db.prepare("SELECT * FROM nodes ORDER BY id").all()) as NodeRow[];
    return rows.map(r => ({ id: r.id, type: r.type as NodeType, props: JSON.parse(r.props) }));
  }
  edges(type?: EdgeType): GraphEdge[] {
    const rows = (type
      ? this.db.prepare('SELECT * FROM edges WHERE type=? ORDER BY "from","to",type').all(type)
      : this.db.prepare('SELECT * FROM edges ORDER BY "from","to",type').all()) as EdgeRow[];
    return rows.map(r => ({ from: r.from, to: r.to, type: r.type as EdgeType, ts: r.ts, source_event_id: r.source_event_id }));
  }
  neighbors(id: string): GraphNode[] {
    const rows = this.db.prepare(`
      SELECT n.* FROM nodes n JOIN edges e ON (e."to"=n.id AND e."from"=?) OR (e."from"=n.id AND e."to"=?)
      GROUP BY n.id ORDER BY n.id`).all(id, id) as NodeRow[];
    return rows.map(r => ({ id: r.id, type: r.type as NodeType, props: JSON.parse(r.props) }));
  }
  snapshot() { return { nodes: this.nodes(), edges: this.edges() }; }
}
