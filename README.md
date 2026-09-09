# agent-relay

A daemon on your laptop/server that exposes your existing,
subscription-backed agent harnesses (Claude Code, Codex, Hermes) through an
API, so your own apps can create sessions, inject context, add tools, and
stream results — without owning the agent loop or paying API rates.
Architecture inspired by T3 Code: the server owns sessions and workspaces,
clients talk over one authenticated RPC connection, and provider processes
never run on the client. Internal-use only.

**Status: M2 — core + Claude driver working.**

## Quickstart

```sh
pnpm install
pnpm test                    # unit + integration tests; gated smoke tests skipped
CLAUDE_SMOKE=1 pnpm test      # also runs a real Claude Code session (~20s), needs a logged-in Claude Code CLI
```

`pnpm test` runs the full unit and integration suite against `FakeDriver`
and a mocked Claude SDK — no network calls, no real harness. Setting
`CLAUDE_SMOKE=1` additionally runs the driver and end-to-end tests against a
real Claude Code process, which requires an authenticated `claude` CLI on
your machine.

## Architecture

```
clients (curl / web demo / your app)
        │  WebSocket + HTTP, bearer token from pairing   [M3]
        ▼
┌──────────────── agent-relay daemon (Node/TS) ───────────────────┐
│ interface   │ REST+WS API (Hono + ws), pairing, OpenAPI  [M3]    │
│ governance  │ auth, per-session policy, canUseTool, sandbox      │
│ execution   │ SessionManager → Driver adapters:                  │
│             │   ClaudeDriver (Agent SDK query/resume/hooks)      │
│             │   CodexDriver, HermesDriver                 [M4]   │
│ context     │ workspace/ per session (workbench copy), injectors │
│ telemetry   │ event log (JSONL, append-only) → graph projection  │
│ memory      │ SessionGraph (SQLite) + exporters           [M6]   │
└─────────────────────────────────────────────────────────────────┘
```

Data flow: `SessionManager.createSession()` copies the workbench template
into a fresh per-session workspace directory → `SessionManager.run()` hands
the prompt to the session's driver, which spawns the harness with `cwd` set
to that workspace → every SDK message becomes both an `RelayEvent` in the
append-only log and a node/edge in the projected `SessionGraph` → a
`run.finished` event closes the run with a `Receipt` node, even when the
driver throws.

Full design spec:
[docs/superpowers/specs/2026-09-09-agent-relay-design.md](docs/superpowers/specs/2026-09-09-agent-relay-design.md)

## Docs

- [docs/graph-model.md](docs/graph-model.md) — node/edge types, ID
  conventions, the rebuild guarantee, a worked example.
- [docs/security.md](docs/security.md) — what the workspace policy denies,
  what it does not protect against, and what M3 adds.

## What works

- `EventLog`: append-only JSONL event log, replayable (`packages/core/src/event-log.ts`).
- `SessionGraph`: typed nodes/edges projected from the event log, with a
  deterministic rebuild and provenance on every edge (`packages/core/src/graph.ts`).
- `SessionManager`: creates sessions with per-session workspaces, runs
  prompts through a driver, records a terminal `run.finished` (subtype
  `error` or `cancelled`) even if the driver throws mid-run
  (`packages/core/src/session-manager.ts`).
- `FakeDriver`: deterministic driver for unit tests, exercising the same
  `Driver` interface real drivers implement.
- `ClaudeDriver`: runs real Claude Code via the Agent SDK, maps SDK
  messages to `DriverEvent`s, resumes by harness session id, and enforces
  the workspace policy through `canUseTool`.
- Workspace policy (`packages/drivers/claude/src/policy.ts`): symlink-safe,
  realpath-based containment check; default-deny with an explicit tool
  allowlist; Bash denied unless opted in, and gated by a regex heuristic
  even then. See `docs/security.md`.
- End-to-end (`packages/core/test/e2e-claude.test.ts`, gated on
  `CLAUDE_SMOKE=1`): a real Claude Code session, through `SessionManager`,
  writes a file and attempts to read `/etc/hosts`; asserts the `Artifact`
  node exists, the denied read shows up as a `ToolCall` node with
  `denied: true`, and exactly one `Receipt` node exists.

## What is unverified

- No server, no HTTP/WebSocket API, no pairing/auth, no network exposure —
  all M3.
- No Codex or Hermes drivers yet — M4.
- No context-injection endpoint or custom in-process tools yet — M5.
- No graph export (`graphify`/Cypher) or demo GIF yet — M6.
- No `sandbox-exec` process confinement — the workspace policy is enforced
  only through `canUseTool`; the harness process itself is not sandboxed.
  See `docs/security.md`.
- No automated CI security scan (semgrep) has been run against this code
  yet.
- Only tested on macOS with a single logged-in Claude Code CLI session;
  concurrent-session and multi-driver behavior under load is unverified.
