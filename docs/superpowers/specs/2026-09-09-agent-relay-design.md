# agent-relay — design spec (2026-09-09)

## Context

Reel transcript (auto-transcribed) describes a portfolio project: a daemon on your laptop/server that exposes your *existing, subscription-backed* agent harnesses (Claude Code, Codex) through an API so your own apps can create sessions, inject context, add tools, and stream results — without owning the agent loop or paying API rates. Architecture inspired by T3 Code (server owns sessions/workspaces; clients talk over one authenticated RPC WebSocket; provider processes never run in the client). Explicit risks: auth (do T3-style pairing, never an open port) and sandboxing (per-session workspace, not the whole disk). Internal-use only.

Decisions already made with Josh:
- Goal: **hireable public showcase** (clean architecture, diagrams, tests, demo GIF).
- Harnesses in v1: **Claude Code + Codex + Hermes** (adapter pattern from day one).
- Graph/memory: **session graph is the core data model**, memory persisted per Cyclopedia-Galactica conventions.
- Stack: **TypeScript + Claude Agent SDK**. Sandbox: **per-session workspace dir + `sandbox-exec` + `canUseTool` path denial**. Repo: `~/Projects/agent-relay`, public under Josh's personal GitHub.

## Knowledge sources this plan applies

**Jake Van Clief repo** (`~/Projects/jake-van-clief-knowledge/knowledge/concepts/`):
- `three-layer-context-routing.md` — front desk → room context → active files. The repo layout and each session workspace follow this.
- `position-addressed-memory.md` — paths carry meaning; link-addressed (graph) memory added only where cross-session discovery is central. Justifies: filesystem workspace per session (position) + graph for cross-session relationships (link).
- `ai-interface-layer-selection.md` — name the access need before the tool; the daemon is exactly the "custom orchestration" layer, justified because the job needs custom permissions, audit logs, isolation.
- `coding-agent-plan-edit-verify-loop.md`, `truth-decks-and-ai-evals.md` — session lifecycle stages and eval set for the README.

**Cyclopedia-Galactica/agent-memory** (`~/Projects/agent-memory/`):
- `architecture/production-agent-stack.md` — interface / context / execution / governance / telemetry / validation layers → the daemon's module boundaries.
- `architecture/outcome-routing-control-plane.md` + `schemas/*.schema.json` — reuse `intent-contract.v1`, `route-decision.v1`, `execution-receipt.v1` shapes as graph node types (adapted, not copied verbatim).
- `notes/08-workbench-architecture.md` WB-1..3 (front desk, template vs copy, multiplayer = shared artifacts), `notes/02-control-loops.md` LOOP-5 (circuit breaker), `notes/03-host-reality.md` HOST-5 (LISTEN ≠ reachable), `notes/07-agent-conduct.md`.
- `workbench-template/` — each session workspace is a copy of a slim workbench (REQUEST.md, STATUS.md, ARTIFACT_REGISTRY.md).
- Contribution rule: lessons learned while building go back as sanitized laws via `scripts/preflight.sh` + PR (that repo is read-only on main).

**Graph engineering principles** (apply throughout):
1. Typed nodes and edges, schema-validated (JSON Schema, like agent-memory).
2. Provenance on every edge (who/what created it, when, from which event).
3. Append-only event log is the source of truth; the graph is a projection (rebuildable).
4. Position-addressed first: node IDs are stable paths (`session/<id>/run/<n>/tool/<k>`).
5. Query by traversal, not by scanning: the API exposes neighbourhood/path queries.
6. Export to `graphify`/GraphRAG JSON and Neo4j Cypher so the graph is inspectable with tools Josh already has (`/graphify --neo4j`).

## Architecture

```
clients (curl / web demo / your video-editor app)
        │  WebSocket + HTTP, bearer token from pairing
        ▼
┌──────────────── agent-relay daemon (Node/TS) ───────────────────┐
│ interface   │ REST+WS API (Hono + ws), pairing, OpenAPI          │
│ governance  │ auth, per-session policy, canUseTool, sandbox      │
│ execution   │ SessionManager → Driver adapters:                  │
│             │   ClaudeDriver (Agent SDK query/resume/hooks)      │
│             │   CodexDriver  (codex exec --json / app-server)    │
│             │   HermesDriver (local Hermes gateway ws)           │
│ context     │ workspace/ per session (workbench copy), injectors │
│ telemetry   │ event log (JSONL, append-only) → graph projection  │
│ memory      │ SessionGraph (SQLite) + exporters (graphify/Cypher)│
└─────────────────────────────────────────────────────────────────┘
```

Data flow: `POST /sessions` → IntentContract node → workspace copied from template → driver spawns harness in that cwd → every SDK message becomes an Event (log) and a node/edge (graph) → streamed to client over WS → `result` closes the Run with an ExecutionReceipt node.

### Graph model (v1)
Nodes: `Session`, `Run`, `Message`, `ToolCall`, `Artifact` (file written), `ContextInjection`, `Driver`, `Workspace`, `Receipt`.
Edges: `HAS_RUN`, `PRODUCED`, `CALLED`, `WROTE`, `INJECTED_INTO`, `RESUMED_FROM`, `EXECUTED_BY`, `RECEIPTED_BY`. All edges carry `{ts, source_event_id}`.
Storage: SQLite via `better-sqlite3`, two tables (`nodes`, `edges`) + `events`. Graph is rebuilt from `events` by `rebuild()`; test asserts determinism.

## Repo layout (three-layer routing)

```
agent-relay/
  README.md              # front desk: what/why/threat model/quickstart/demo GIF
  AGENTS.md              # room context for agents working in this repo
  docs/
    architecture.md      # diagram + layer mapping (cites Van Clief + agent-memory)
    graph-model.md       # node/edge schema, examples, rebuild guarantee
    security.md          # pairing, token, sandbox, what is NOT protected
    superpowers/specs/   # design spec (brainstorming output)
  packages/
    core/                # SessionManager, EventLog, SessionGraph, Policy
    drivers/             # claude/, codex/, hermes/  (one interface, three impls)
    server/              # Hono HTTP + WS, pairing, OpenAPI
    cli/                 # `agent-relay start|pair|sessions|export-graph`
  examples/
    web-demo/            # tiny Vite page: create session, inject context, stream
  schemas/               # JSON Schema for nodes, edges, events, intent
  workbench-template/    # copied into each session workspace
  tests/                 # vitest unit + e2e (fake driver + real Claude smoke)
```

## Milestones

**M0 Spec + scaffold**: brainstorming spec in `docs/superpowers/specs/2026-09-09-agent-relay-design.md`; pnpm monorepo, vitest, tsconfig, CI (lint/test/semgrep).

**M1 Core + FakeDriver**: `Driver` interface (`start`, `send`, `resume`, `cancel`, `events()`); `EventLog` JSONL; `SessionGraph` with rebuild test; `SessionManager`. TDD throughout.

**M2 ClaudeDriver**: Agent SDK `query()` with `cwd=workspace`, `resume` from `session_id`, `canUseTool` denying paths outside workspace, hooks mapped to events. Smoke test gated on `CLAUDE_SMOKE=1`.

**M3 Server + auth + sandbox**: pairing flow (`agent-relay pair` prints one-time code → client exchanges for bearer token; tokens hashed on disk); loopback-only bind by default; WS stream; `sandbox-exec` profile wrapper; circuit breaker per session (LOOP-5).

**M4 Codex + Hermes drivers**: Codex via `codex exec --json` (or app-server if stable); Hermes via its local gateway websocket (see `~/.hermes/config.yaml`). Contract tests run against all three through the same FakeDriver-derived suite.

**M5 Context injection + tools**: `POST /sessions/:id/context` (writes to workspace `CONTEXT.md` + records `ContextInjection` node); custom tools exposed to Claude via in-process MCP server from the SDK.

**M6 Graph export + demo**: `export-graph --graphify | --cypher`; run `/graphify` on a real session and embed the HTML screenshot; web-demo GIF; README truth deck (what works / what is unverified).

**M7 Close the loop**: sanitize lessons into agent-memory laws via PR; log implementation notes in `jake-van-clief-knowledge/knowledge/hermes-implementation-log.md`.

## Security posture (documented, not hand-waved)
- Loopback bind + pairing token; LAN exposure opt-in with explicit flag and warning.
- Per-session workspace; `canUseTool` denies Read/Write/Bash targets outside it; `sandbox-exec` profile limits filesystem.
- Explicit non-goals in `docs/security.md`: not a multi-tenant product; host credentials remain readable by the harness (subscription login) — stated plainly.
- Run `static-analysis:semgrep` on server + drivers before publishing.

## Verification
- `pnpm test`: unit (graph rebuild determinism, policy denial, pairing), contract suite across FakeDriver/Claude/Codex/Hermes.
- E2E: start daemon → pair → create session with a prompt that writes a file → assert file in workspace, `Artifact` node exists, WS stream ended with `Receipt`.
- Browser: Playwright click-through of `examples/web-demo` (create session, inject context, see streamed output) with screenshots for README.
- Security: attempt Read of `~/.ssh` from a session → assert denied event recorded in graph.
- Graph: `export-graph --graphify` output loads in `/graphify` viewer.

## Next step after approval
Invoke `superpowers:writing-plans` to turn M0–M2 into a task-level implementation plan; Superdesign pass before building `examples/web-demo`.
