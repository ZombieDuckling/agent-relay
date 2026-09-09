# AGENTS.md — how to work in this repo

Front desk: README.md. Design spec: docs/superpowers/specs/. Plans: docs/superpowers/plans/.

| Task | Read first | Output | Verify |
|---|---|---|---|
| Change core model | packages/core/src/events.ts, graph.ts | same package + test | `pnpm test` |
| Add a driver | packages/core/src/driver.ts, fake-driver.ts | packages/drivers/<name>/ | contract test passes |
| Touch security | docs/security.md, drivers/claude/src/policy.ts | policy test | denial recorded as event |

Rules: TDD; event log is the source of truth; never commit workspaces/ or .relay/; no secrets or host paths.
