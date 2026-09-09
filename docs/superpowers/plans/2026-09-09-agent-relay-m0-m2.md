# agent-relay M0–M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the `agent-relay` monorepo, build the graph-backed core with a FakeDriver, and add a real ClaudeDriver on the Claude Agent SDK with workspace-scoped permissions.

**Architecture:** Append-only JSONL `EventLog` is the source of truth; `SessionGraph` (SQLite nodes/edges) is a rebuildable projection. `SessionManager` owns sessions and delegates harness execution to a `Driver` interface. `ClaudeDriver` maps Agent SDK messages to events and denies tool use outside the session workspace via `canUseTool`.

**Tech Stack:** TypeScript 5 (strict, ESM, NodeNext), Node 22, pnpm 10 workspaces, vitest, better-sqlite3, zod, `@anthropic-ai/claude-agent-sdk@0.3.266`.

## Global Constraints

- Node `>=22`, pnpm `>=10`, ESM only (`"type": "module"`), `moduleResolution: "NodeNext"`.
- Node IDs are position-addressed paths: `session/<sid>`, `session/<sid>/run/<n>`, `session/<sid>/run/<n>/msg/<k>`, `session/<sid>/run/<n>/tool/<k>`, `artifact/<sid>/<relpath>`, `driver/<name>`, `workspace/<sid>`.
- Every edge carries `{ ts: string (ISO), source_event_id: string }`.
- `SessionGraph.rebuild()` from the event log must be deterministic (same events → identical node/edge sets).
- No secrets, home paths, or hostnames in committed files (agent-memory Rule 1).
- Commits end with the attribution trailer given in the session.

---

## File structure

```
agent-relay/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.config.ts  .gitignore  .github/workflows/ci.yml
  README.md  AGENTS.md
  schemas/event.schema.json  schemas/node.schema.json  schemas/edge.schema.json
  workbench-template/{REQUEST.md,STATUS.md,ARTIFACT_REGISTRY.md,CONTEXT.md}
  packages/core/
    package.json  tsconfig.json
    src/index.ts
    src/events.ts          # Event types + zod schema
    src/event-log.ts       # append-only JSONL
    src/graph.ts           # SessionGraph (sqlite) + rebuild()
    src/driver.ts          # Driver interface + DriverEvent
    src/workspace.ts       # copy workbench-template → workspace dir
    src/session-manager.ts
    src/fake-driver.ts
    test/event-log.test.ts test/graph.test.ts test/workspace.test.ts test/session-manager.test.ts
  packages/drivers/claude/
    package.json  tsconfig.json
    src/index.ts  src/claude-driver.ts  src/policy.ts
    test/policy.test.ts  test/claude-driver.smoke.test.ts
```

---

### Task 1: Monorepo scaffold + CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`, `.github/workflows/ci.yml`, `AGENTS.md`, `README.md`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`

**Interfaces:** Produces: `pnpm test` and `pnpm typecheck` scripts that later tasks rely on.

- [ ] **Step 1: Write root config**

`package.json`
```json
{
  "name": "agent-relay",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.29.3",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b packages/core packages/drivers/claude",
    "lint": "biome check ."
  },
  "devDependencies": {
    "@biomejs/biome": "^2.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

`pnpm-workspace.yaml`
```yaml
packages:
  - "packages/*"
  - "packages/drivers/*"
```

`tsconfig.base.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true
  }
}
```

`vitest.config.ts`
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/**/test/**/*.test.ts"], testTimeout: 20_000 },
});
```

`.gitignore`
```
node_modules
dist
*.tsbuildinfo
.relay/
**/workspaces/
```

`packages/core/package.json`
```json
{
  "name": "@agent-relay/core",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
  "scripts": { "build": "tsc -b" },
  "dependencies": { "better-sqlite3": "^11.0.0", "zod": "^3.23.0" },
  "devDependencies": { "@types/better-sqlite3": "^7.6.0" }
}
```

`packages/core/tsconfig.json`
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src"] }
```

`packages/core/src/index.ts`
```ts
export const VERSION = "0.0.1";
```

`packages/core/test/smoke.test.ts`
```ts
import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";
test("core exports version", () => { expect(VERSION).toBe("0.0.1"); });
```

`.github/workflows/ci.yml`
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

`AGENTS.md` (room context, three-layer routing)
```markdown
# AGENTS.md — how to work in this repo

Front desk: README.md. Design spec: docs/superpowers/specs/. Plans: docs/superpowers/plans/.

| Task | Read first | Output | Verify |
|---|---|---|---|
| Change core model | packages/core/src/events.ts, graph.ts | same package + test | `pnpm test` |
| Add a driver | packages/core/src/driver.ts, fake-driver.ts | packages/drivers/<name>/ | contract test passes |
| Touch security | docs/security.md, drivers/claude/src/policy.ts | policy test | denial recorded as event |

Rules: TDD; event log is the source of truth; never commit workspaces/ or .relay/; no secrets or host paths.
```

`README.md`: title, one-paragraph purpose (from spec Context), "Status: M0 scaffold", link to spec.

- [ ] **Step 2: Install and run**

Run: `pnpm install && pnpm test`
Expected: 1 test passed.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold pnpm monorepo, vitest, CI"
```

---

### Task 2: Event types and EventLog

**Files:**
- Create: `packages/core/src/events.ts`, `packages/core/src/event-log.ts`, `packages/core/test/event-log.test.ts`, `schemas/event.schema.json`

**Interfaces:**
- Produces:
  - `type RelayEvent = { id: string; ts: string; session_id: string; run?: number; kind: EventKind; data: Record<string, unknown> }`
  - `type EventKind = "session.created" | "run.started" | "message" | "tool.called" | "tool.denied" | "artifact.written" | "context.injected" | "run.finished" | "session.cancelled"`
  - `class EventLog { constructor(path: string); append(e: Omit<RelayEvent,"id"|"ts">): RelayEvent; readAll(): RelayEvent[]; readSession(sid: string): RelayEvent[] }`

- [ ] **Step 1: Failing test**

`packages/core/test/event-log.test.ts`
```ts
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
```

- [ ] **Step 2: Run** `pnpm vitest run packages/core/test/event-log.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/events.ts`
```ts
import { z } from "zod";

export const EventKind = z.enum([
  "session.created", "run.started", "message", "tool.called", "tool.denied",
  "artifact.written", "context.injected", "run.finished", "session.cancelled",
]);
export type EventKind = z.infer<typeof EventKind>;

export const RelayEventSchema = z.object({
  id: z.string().regex(/^evt_/),
  ts: z.string().datetime(),
  session_id: z.string().min(1),
  run: z.number().int().nonnegative().optional(),
  kind: EventKind,
  data: z.record(z.unknown()),
});
export type RelayEvent = z.infer<typeof RelayEventSchema>;
export type NewEvent = Omit<RelayEvent, "id" | "ts">;
```

`packages/core/src/event-log.ts`
```ts
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { RelayEventSchema, type NewEvent, type RelayEvent } from "./events.js";

export class EventLog {
  constructor(private readonly path: string) {}

  append(e: NewEvent): RelayEvent {
    const full = RelayEventSchema.parse({ ...e, id: `evt_${randomUUID()}`, ts: new Date().toISOString() });
    appendFileSync(this.path, JSON.stringify(full) + "\n");
    return full;
  }

  readAll(): RelayEvent[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n").filter(Boolean)
      .map(line => RelayEventSchema.parse(JSON.parse(line)));
  }

  readSession(sid: string): RelayEvent[] {
    return this.readAll().filter(e => e.session_id === sid);
  }
}
```

`schemas/event.schema.json`: JSON Schema equivalent of `RelayEventSchema` (id pattern `^evt_`, required `id,ts,session_id,kind,data`, `kind` enum listing the nine kinds).

Export both from `src/index.ts`.

- [ ] **Step 4: Run** same command → PASS (2 tests).
- [ ] **Step 5: Commit** `git commit -am "feat(core): RelayEvent schema and append-only EventLog"`

---

### Task 3: SessionGraph projection with deterministic rebuild

**Files:**
- Create: `packages/core/src/graph.ts`, `packages/core/test/graph.test.ts`, `schemas/node.schema.json`, `schemas/edge.schema.json`

**Interfaces:**
- Consumes: `RelayEvent`, `EventLog.readAll()`.
- Produces:
  - `type NodeType = "Session"|"Run"|"Message"|"ToolCall"|"Artifact"|"ContextInjection"|"Driver"|"Workspace"|"Receipt"`
  - `type EdgeType = "HAS_RUN"|"PRODUCED"|"CALLED"|"WROTE"|"INJECTED_INTO"|"RESUMED_FROM"|"EXECUTED_BY"|"RECEIPTED_BY"`
  - `class SessionGraph { constructor(dbPath: string | ":memory:"); apply(e: RelayEvent): void; rebuild(events: RelayEvent[]): void; nodes(type?: NodeType): GraphNode[]; edges(type?: EdgeType): GraphEdge[]; neighbors(id: string): GraphNode[]; snapshot(): {nodes: GraphNode[]; edges: GraphEdge[]} }`
  - `GraphNode = { id: string; type: NodeType; props: Record<string,unknown> }`, `GraphEdge = { from: string; to: string; type: EdgeType; ts: string; source_event_id: string }`

- [ ] **Step 1: Failing test**

`packages/core/test/graph.test.ts`
```ts
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
  test("neighbors traverses both directions", () => {
    const g = new SessionGraph(":memory:"); g.rebuild(events);
    const ids = g.neighbors("session/s1/run/0").map(n => n.id).sort();
    expect(ids).toEqual(["session/s1", "session/s1/run/0/receipt", "session/s1/run/0/tool/0"]);
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/graph.ts`
```ts
import Database from "better-sqlite3";
import type { RelayEvent } from "./events.js";

export type NodeType = "Session"|"Run"|"Message"|"ToolCall"|"Artifact"|"ContextInjection"|"Driver"|"Workspace"|"Receipt";
export type EdgeType = "HAS_RUN"|"PRODUCED"|"CALLED"|"WROTE"|"INJECTED_INTO"|"RESUMED_FROM"|"EXECUTED_BY"|"RECEIPTED_BY";
export type GraphNode = { id: string; type: NodeType; props: Record<string, unknown> };
export type GraphEdge = { from: string; to: string; type: EdgeType; ts: string; source_event_id: string };

export class SessionGraph {
  private db: Database.Database;
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
    this.db.prepare("INSERT OR REPLACE INTO nodes(id,type,props) VALUES(?,?,?)").run(n.id, n.type, JSON.stringify(n.props));
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
        break;
      }
      case "artifact.written": {
        if (!run) return;
        const id = `artifact/${e.session_id}/${e.data.path}`;
        this.upsertNode({ id, type: "Artifact", props: { path: e.data.path } });
        this.addEdge({ from: run, to: id, type: "WROTE", ...prov });
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
    const tx = this.db.transaction((evs: RelayEvent[]) => { for (const e of evs) this.apply(e); });
    tx(events);
  }

  nodes(type?: NodeType): GraphNode[] {
    const rows = type
      ? this.db.prepare("SELECT * FROM nodes WHERE type=? ORDER BY id").all(type)
      : this.db.prepare("SELECT * FROM nodes ORDER BY id").all();
    return (rows as any[]).map(r => ({ id: r.id, type: r.type, props: JSON.parse(r.props) }));
  }
  edges(type?: EdgeType): GraphEdge[] {
    const rows = type
      ? this.db.prepare('SELECT * FROM edges WHERE type=? ORDER BY "from","to",type').all(type)
      : this.db.prepare('SELECT * FROM edges ORDER BY "from","to",type').all();
    return rows as GraphEdge[];
  }
  neighbors(id: string): GraphNode[] {
    const rows = this.db.prepare(`
      SELECT n.* FROM nodes n JOIN edges e ON (e."to"=n.id AND e."from"=?) OR (e."from"=n.id AND e."to"=?)
      GROUP BY n.id ORDER BY n.id`).all(id, id);
    return (rows as any[]).map(r => ({ id: r.id, type: r.type, props: JSON.parse(r.props) }));
  }
  snapshot() { return { nodes: this.nodes(), edges: this.edges() }; }
}
```

Write `schemas/node.schema.json` and `schemas/edge.schema.json` mirroring `GraphNode`/`GraphEdge` (enum the types; edge requires `ts` and `source_event_id`). Export from `index.ts`.

- [ ] **Step 4: Run** → PASS (3 tests).
- [ ] **Step 5: Commit** `git commit -am "feat(core): SessionGraph sqlite projection with deterministic rebuild"`

---

### Task 4: Driver interface, workspace, FakeDriver

**Files:**
- Create: `packages/core/src/driver.ts`, `packages/core/src/workspace.ts`, `packages/core/src/fake-driver.ts`, `workbench-template/*`, `packages/core/test/workspace.test.ts`

**Interfaces:**
- Produces:
```ts
export type DriverEvent =
  | { type: "init"; harness_session_id: string }
  | { type: "message"; role: "assistant" | "user"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "tool_denied"; name: string; input: unknown; reason: string }
  | { type: "artifact"; path: string }
  | { type: "result"; subtype: "success" | "error" | "cancelled"; num_turns?: number; duration_ms?: number; cost_usd?: number; error?: string };
export type RunOptions = { workspace: string; prompt: string; resume?: string; signal: AbortSignal };
export interface Driver { readonly name: string; run(opts: RunOptions): AsyncIterable<DriverEvent>; }
export function createWorkspace(root: string, sid: string, templateDir: string): string; // returns workspace path
```

- [ ] **Step 1: Failing test** `packages/core/test/workspace.test.ts`
```ts
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
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

`workbench-template/REQUEST.md`: `# Request\n\n<!-- prompt is appended here by agent-relay -->\n`
`workbench-template/STATUS.md`: `# Status\n\nsession: {{SESSION_ID}}\nstate: created\n`
`workbench-template/ARTIFACT_REGISTRY.md`: `# Artifacts\n\n| path | run | note |\n|---|---|---|\n`
`workbench-template/CONTEXT.md`: `# Context\n\n<!-- injected context appears below -->\n`

`packages/core/src/driver.ts` — the types above, verbatim.

`packages/core/src/workspace.ts`
```ts
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function createWorkspace(root: string, sid: string, templateDir: string): string {
  const ws = join(root, sid);
  mkdirSync(ws, { recursive: true });
  cpSync(templateDir, ws, { recursive: true });
  const status = join(ws, "STATUS.md");
  writeFileSync(status, readFileSync(status, "utf8").replaceAll("{{SESSION_ID}}", sid));
  return ws;
}
```

`packages/core/src/fake-driver.ts`
```ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver, DriverEvent, RunOptions } from "./driver.js";
export class FakeDriver implements Driver {
  readonly name = "fake";
  async *run(o: RunOptions): AsyncIterable<DriverEvent> {
    yield { type: "init", harness_session_id: `fake-${Date.now()}` };
    yield { type: "message", role: "assistant", text: `ok: ${o.prompt}` };
    const file = "hello.txt";
    yield { type: "tool", name: "Write", input: { file_path: join(o.workspace, file) } };
    writeFileSync(join(o.workspace, file), "hello\n");
    yield { type: "artifact", path: file };
    yield { type: "result", subtype: "success", num_turns: 1, duration_ms: 1 };
  }
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(core): Driver interface, workspace template copy, FakeDriver"`

---

### Task 5: SessionManager wires driver → event log → graph

**Files:**
- Create: `packages/core/src/session-manager.ts`, `packages/core/test/session-manager.test.ts`

**Interfaces:**
- Consumes: `EventLog`, `SessionGraph`, `Driver`, `createWorkspace`.
- Produces:
```ts
export type SessionManagerOptions = { dataDir: string; templateDir: string; drivers: Record<string, Driver> };
export class SessionManager {
  constructor(o: SessionManagerOptions);
  createSession(driverName: string): { id: string; workspace: string };
  run(sid: string, prompt: string): AsyncIterable<RelayEvent>;   // yields every persisted event for this run
  cancel(sid: string): void;
  events(sid: string): RelayEvent[];
  readonly graph: SessionGraph;
}
```

- [ ] **Step 1: Failing test**
```ts
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
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
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
      data: { prompt, ...(run > 0 ? { resumed_from: run - 1 } : {}) } });
    let msg = 0, tool = 0;
    for await (const ev of driver.run({ workspace: s.workspace, prompt, resume: s.harnessSessionId, signal: s.abort.signal })) {
      switch (ev.type) {
        case "init": s.harnessSessionId = ev.harness_session_id; break;
        case "message": yield this.record({ session_id: sid, run, kind: "message", data: { index: msg++, role: ev.role, text: ev.text } }); break;
        case "tool": yield this.record({ session_id: sid, run, kind: "tool.called", data: { index: tool++, name: ev.name, input: ev.input } }); break;
        case "tool_denied": yield this.record({ session_id: sid, run, kind: "tool.denied", data: { index: tool++, name: ev.name, input: ev.input, reason: ev.reason } }); break;
        case "artifact": yield this.record({ session_id: sid, run, kind: "artifact.written", data: { path: ev.path } }); break;
        case "result": yield this.record({ session_id: sid, run, kind: "run.finished", data: { ...ev, type: undefined } }); break;
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
```

Note: strip `type` from the result payload before persisting (`const { type: _t, ...rest } = ev`) so `data` has no `type: undefined`.

- [ ] **Step 4: Run** `pnpm test` → all PASS. `pnpm typecheck` → clean.
- [ ] **Step 5: Commit** `git commit -am "feat(core): SessionManager persists driver events and projects graph"`

---

### Task 6: Workspace policy for canUseTool

**Files:**
- Create: `packages/drivers/claude/package.json`, `tsconfig.json`, `src/policy.ts`, `test/policy.test.ts`

**Interfaces:**
- Produces: `export function decideToolUse(workspace: string, toolName: string, input: unknown): { allow: true } | { allow: false; reason: string }`

`packages/drivers/claude/package.json`
```json
{
  "name": "@agent-relay/driver-claude",
  "version": "0.0.1",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsc -b" },
  "dependencies": { "@agent-relay/core": "workspace:*", "@anthropic-ai/claude-agent-sdk": "0.3.266" }
}
```
`tsconfig.json`: extends base, `references: [{ "path": "../../core" }]`, rootDir src, outDir dist.

- [ ] **Step 1: Failing test** `test/policy.test.ts`
```ts
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
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/policy.ts`
```ts
import { resolve, relative, isAbsolute } from "node:path";

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);
const DENY_TOOLS = new Set(["WebFetch", "WebSearch"]);
const BASH_FORBIDDEN = [/~\//, /\/Users\/[^ ]+\/\.(ssh|aws|gnupg|config)/, /\/etc\//, /\$HOME/];

function inside(workspace: string, p: string): boolean {
  const rel = relative(resolve(workspace), resolve(workspace, p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function decideToolUse(workspace: string, toolName: string, input: unknown): { allow: true } | { allow: false; reason: string } {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (DENY_TOOLS.has(toolName)) return { allow: false, reason: `${toolName} disabled by relay policy` };
  if (FILE_TOOLS.has(toolName)) {
    const p = String(inp.file_path ?? inp.notebook_path ?? "");
    return inside(workspace, p) ? { allow: true } : { allow: false, reason: `path outside workspace: ${p}` };
  }
  if (toolName === "Bash") {
    const cmd = String(inp.command ?? "");
    const hit = BASH_FORBIDDEN.find(r => r.test(cmd));
    return hit ? { allow: false, reason: `command references protected path` } : { allow: true };
  }
  return { allow: true };
}
```

- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(driver-claude): workspace tool-use policy"`

---

### Task 7: ClaudeDriver on the Agent SDK

**Files:**
- Create: `packages/drivers/claude/src/claude-driver.ts`, `src/index.ts`, `test/claude-driver.test.ts` (unit, with injected fake `query`), `test/claude-driver.smoke.test.ts` (real, gated)

**Interfaces:**
- Consumes: `Driver`, `DriverEvent`, `RunOptions` from core; `decideToolUse`.
- Produces: `export class ClaudeDriver implements Driver { constructor(deps?: { query?: typeof query; model?: string }) }`

SDK facts (v0.3.266): `query({ prompt, options })` returns an async iterable of `SDKMessage`; options used: `cwd`, `resume`, `abortController`, `permissionMode: "default"`, `canUseTool(req, {signal}) → {allow, reason?}`, `maxTurns`. Message types used: `system_init` (`session_id`), `assistant` (`content[]` with `text`/`tool_use`), `tool_use` (`name`,`input`), `result` (`subtype`, `num_turns`, `duration_ms`, `total_cost_usd`, `is_error`). Verify names against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and adjust the mapping if the installed types differ; the unit test injects `query`, so the mapping is the thing under test.

- [ ] **Step 1: Failing unit test** `test/claude-driver.test.ts`
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ClaudeDriver } from "../src/claude-driver.js";

function fakeQuery(msgs: any[]) {
  return ({ options }: any) => (async function* () {
    for (const m of msgs) {
      if (m.type === "tool_use" && options.canUseTool) {
        const d = await options.canUseTool({ toolName: m.name, toolInput: m.input }, { signal: options.abortController.signal });
        if (!d.allow) { yield { type: "tool_denied_marker", name: m.name, input: m.input, reason: d.reason }; continue; }
      }
      yield m;
    }
  })();
}

test("maps SDK messages to DriverEvents and denies out-of-workspace writes", async () => {
  const ws = mkdtempSync(join(tmpdir(), "cd-"));
  const q = fakeQuery([
    { type: "system_init", session_id: "sess-1" },
    { type: "assistant", content: [{ type: "text", text: "working" }] },
    { type: "tool_use", name: "Write", input: { file_path: join(ws, "out.md") } },
    { type: "tool_use", name: "Read", input: { file_path: "/etc/hosts" } },
    { type: "result", subtype: "success", num_turns: 2, duration_ms: 10, total_cost_usd: 0 },
  ]);
  const d = new ClaudeDriver({ query: q as any });
  const out: any[] = [];
  for await (const e of d.run({ workspace: ws, prompt: "p", signal: new AbortController().signal })) out.push(e);
  expect(out.map(e => e.type)).toEqual(["init", "message", "tool", "artifact", "tool_denied", "result"]);
  expect(out[0]).toEqual({ type: "init", harness_session_id: "sess-1" });
  expect(out[3]).toEqual({ type: "artifact", path: "out.md" });
  expect(out[4].reason).toMatch(/outside workspace/);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `src/claude-driver.ts`
```ts
import { relative } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Driver, DriverEvent, RunOptions } from "@agent-relay/core";
import { decideToolUse } from "./policy.js";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export class ClaudeDriver implements Driver {
  readonly name = "claude";
  private q: typeof sdkQuery;
  private model?: string;
  constructor(deps: { query?: typeof sdkQuery; model?: string } = {}) {
    this.q = deps.query ?? sdkQuery;
    this.model = deps.model;
  }

  async *run(o: RunOptions): AsyncIterable<DriverEvent> {
    const abortController = new AbortController();
    o.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    const pending: DriverEvent[] = [];

    const stream = this.q({
      prompt: o.prompt,
      options: {
        cwd: o.workspace,
        resume: o.resume,
        abortController,
        permissionMode: "default",
        maxTurns: 25,
        ...(this.model ? { model: this.model } : {}),
        canUseTool: async (req: any) => {
          const d = decideToolUse(o.workspace, req.toolName, req.toolInput);
          if (!d.allow) pending.push({ type: "tool_denied", name: req.toolName, input: req.toolInput, reason: d.reason });
          return d;
        },
      } as any,
    });

    for await (const m of stream as AsyncIterable<any>) {
      while (pending.length) yield pending.shift()!;
      switch (m.type) {
        case "system_init": yield { type: "init", harness_session_id: m.session_id }; break;
        case "assistant":
          for (const c of m.content ?? []) if (c.type === "text" && c.text) yield { type: "message", role: "assistant", text: c.text };
          break;
        case "tool_use": {
          yield { type: "tool", name: m.name, input: m.input };
          const p = (m.input as any)?.file_path;
          if (WRITE_TOOLS.has(m.name) && typeof p === "string") yield { type: "artifact", path: relative(o.workspace, p) };
          break;
        }
        case "tool_denied_marker": break; // test-only marker; real denials come via pending
        case "result":
          while (pending.length) yield pending.shift()!;
          yield { type: "result", subtype: m.is_error ? "error" : abortController.signal.aborted ? "cancelled" : "success",
            num_turns: m.num_turns, duration_ms: m.duration_ms, cost_usd: m.total_cost_usd, error: m.is_error ? m.message : undefined };
          break;
      }
    }
    while (pending.length) yield pending.shift()!;
  }
}
```
`src/index.ts`: `export { ClaudeDriver } from "./claude-driver.js"; export { decideToolUse } from "./policy.js";`

If the installed SDK emits `tool_use` inside `assistant.content` rather than as a top-level `tool_use` message, handle both: in the `assistant` case, also iterate `c.type === "tool_use"` blocks with the same logic as the top-level case. Confirm by reading `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (grep `SDKMessage`).

- [ ] **Step 4: Run** unit test → PASS.

- [ ] **Step 5: Gated smoke test** `test/claude-driver.smoke.test.ts`
```ts
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ClaudeDriver } from "../src/claude-driver.js";

test.skipIf(!process.env.CLAUDE_SMOKE)("real Claude Code writes a file inside the workspace", async () => {
  const ws = mkdtempSync(join(tmpdir(), "smoke-"));
  const d = new ClaudeDriver();
  const events: any[] = [];
  for await (const e of d.run({ workspace: ws, prompt: "Create a file named hello.txt containing exactly: hello", signal: new AbortController().signal })) events.push(e);
  expect(events.at(-1)?.type).toBe("result");
  expect(existsSync(join(ws, "hello.txt"))).toBe(true);
}, 120_000);
```
Run: `CLAUDE_SMOKE=1 pnpm vitest run packages/drivers/claude/test/claude-driver.smoke.test.ts` → PASS (uses the host Claude Code login; requires `claude` on PATH).

- [ ] **Step 6: Commit** `git commit -am "feat(driver-claude): ClaudeDriver on Agent SDK with workspace policy + smoke test"`

---

### Task 8: End-to-end through SessionManager + docs update

**Files:**
- Create: `packages/core/test/e2e-claude.test.ts` (gated), `docs/graph-model.md`, `docs/security.md`
- Modify: `README.md`, `packages/core/src/index.ts` (ensure all exports)

- [ ] **Step 1: Gated e2e test**
```ts
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { ClaudeDriver } from "@agent-relay/driver-claude";

test.skipIf(!process.env.CLAUDE_SMOKE)("session → run → artifact node + receipt", async () => {
  const m = new SessionManager({ dataDir: mkdtempSync(join(tmpdir(), "e2e-")), templateDir: join(import.meta.dirname, "../../../workbench-template"), drivers: { claude: new ClaudeDriver() } });
  const s = m.createSession("claude");
  for await (const _ of m.run(s.id, "Create hello.txt containing exactly: hello. Then try to read /etc/hosts.")) {}
  expect(existsSync(join(s.workspace, "hello.txt"))).toBe(true);
  expect(m.graph.nodes("Artifact").some(n => n.id.endsWith("/hello.txt"))).toBe(true);
  expect(m.graph.nodes("ToolCall").some(n => n.props.denied === true)).toBe(true);
  expect(m.graph.nodes("Receipt")).toHaveLength(1);
}, 180_000);
```
Note: this test package needs `@agent-relay/driver-claude` as a devDependency of core (`workspace:*`); acceptable for tests only.

- [ ] **Step 2: Run** `CLAUDE_SMOKE=1 pnpm test` → PASS; `pnpm test` (no env) → gated tests skipped, rest PASS.

- [ ] **Step 3: Docs**
- `docs/graph-model.md`: node/edge tables from Task 3, ID conventions from Global Constraints, the rebuild guarantee, one worked example (the Task 3 fixture) rendered as a mermaid graph.
- `docs/security.md`: what policy denies (Task 6 table), what it does not (host credentials readable by the harness; Bash regex is a heuristic, not a sandbox), and that M3 adds pairing tokens + `sandbox-exec`.
- `README.md`: status → "M2: core + Claude driver working", quickstart (`pnpm install`, `CLAUDE_SMOKE=1 pnpm test`), architecture diagram from spec, links to docs.

- [ ] **Step 4: Commit** `git commit -am "test: gated e2e; docs: graph model and security posture"`

---

## Self-review

- Spec coverage M0–M2: scaffold/CI (T1), event log + graph + rebuild determinism (T2–T3), Driver interface + FakeDriver (T4), SessionManager (T5), ClaudeDriver with cwd/resume/canUseTool + smoke gate (T6–T7), verification E2E and security-denial-in-graph (T8). Hooks→events mapping from spec M2 is deferred to M5 where hooks are needed for context injection; `tool.denied` is captured via canUseTool which covers the M2 security assertion.
- Type consistency: `DriverEvent` names (`init/message/tool/tool_denied/artifact/result`) are used identically in T4, T5, T7. `RelayEvent.kind` values identical in T2, T3, T5. `decideToolUse` return shape matches SDK `canUseTool` contract.
- No placeholders remain; the one conditional (SDK message shape) has an explicit verification step and both branches specified.
