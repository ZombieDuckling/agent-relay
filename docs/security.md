# Security posture (M2)

This describes the security boundary that exists today, in
`packages/drivers/claude/src/policy.ts`. It is a workspace confinement
policy enforced through the Claude Agent SDK's `canUseTool` hook, not a
sandbox. Read the "What this does not protect against" section before
relying on it for anything sensitive.

## What the policy denies

`decideToolUse(workspace, toolName, input, opts)` is called on every tool
use the SDK proposes, before it runs. Decisions:

| Tool | Rule |
|---|---|
| `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | Allowed only if the target path resolves (via `realpath`, symlink-safe) inside the session workspace. Missing or empty `file_path`/`notebook_path` is denied. A path that does not yet exist is resolved by walking up to the nearest existing ancestor and re-joining the missing segments, so a new file inside the workspace is still allowed and a symlink escape is still caught. |
| `TodoWrite` | Allowed unconditionally (in-process, never touches the filesystem). |
| `Glob`, `Grep`, `LS` | Path-scoped like the file tools: allowed only if the `path` argument resolves inside the session workspace. If `path` is absent or empty, allowed (the harness defaults it to `cwd`, which is the workspace). |
| `Task` | Denied. A subagent spawned via `Task` may not re-enter this `canUseTool` hook for its own tool calls, so it cannot be treated as read-only until that is verified against the SDK. |
| `WebFetch`, `WebSearch` | Denied always — no network egress path through these tools. |
| `Bash` | Denied by default. Only runs if the driver is constructed with `allowBash: true`, and even then only if the command text does not match a list of forbidden patterns (see below). |
| Anything else | Denied by default (`tool not in relay allowlist`). The allowlist is explicit; unrecognized tools do not get a default allow. |

Workspace containment uses `realpathSync.native`, so a symlink inside the
workspace that points outside it is resolved to its real target before the
containment check runs — a symlink cannot be used to escape the workspace
undetected.

Every denial is recorded in the event log as `tool.denied` and projected
into the graph as a `ToolCall` node with `denied: true`
(`packages/core/src/graph.ts`). Nothing is silently dropped.

## Bash: heuristic, not a sandbox

When `allowBash` is opted in, the command string is checked against a
regex denylist covering common ways to reach outside the workspace: `~/`,
`$HOME`, `/etc/`, `/private/`, `/var/root/`, `/root/`, known credential
directories (`.ssh`, `.aws`, `.gnupg`, `.config`), command substitution
(`` ` ``, `$(...)`), and `eval`. This is explicitly a heuristic scan over
raw text, not process confinement. It can be bypassed by encoding,
indirection, alternate shell syntax, or anything the pattern list did not
anticipate. The actual sandboxing mechanism — `sandbox-exec` process
confinement — is not implemented yet; it is planned for M3. Until it lands,
treat `allowBash: true` as "reduces obvious accidents," not "safe against
an adversarial prompt."

## What this does not protect against

- **Host credentials are readable by the harness process.** Claude Code
  runs under the user's own OS account and subscription login. It can read
  anything that account can read outside of what `canUseTool` intercepts —
  the policy only gates tool calls the SDK routes through `canUseTool`, not
  the harness process's own filesystem or network access.
- **The Bash heuristic is a denylist of known-bad patterns, not a sandbox.**
  See above. Assume a determined adversarial prompt can find a bypass.
- **No network egress control.** `WebFetch`/`WebSearch` are denied, but
  nothing here stops a permitted process (e.g. Bash, once opted in) from
  making arbitrary network calls if it gets past the Bash heuristic.
- **Single-user, loopback-only intent.** This is a personal daemon, not a
  multi-tenant service. There is no per-user isolation model. Nothing in M2
  binds a port or exposes this over a network — that's M3's server package
  — but the policy layer itself makes no multi-tenant safety claims.
- **No pairing tokens or auth yet.** Any process able to construct a
  `SessionManager` and call `.run()` can run sessions. Authentication and
  a paired bearer token are M3 work (see the design spec, M3 milestone).
- **No OS-level sandbox yet.** `sandbox-exec` process confinement (macOS
  seatbelt) is planned for M3, alongside pairing tokens. Until then, the
  workspace-path check in `policy.ts` is the only enforced boundary, and it
  only covers tool calls that go through `canUseTool` — not the process
  itself.

## Coming in M3

- Pairing flow: `agent-relay pair` prints a one-time code; clients exchange
  it for a bearer token; tokens are hashed on disk.
- Loopback-only bind by default, with LAN exposure opt-in and an explicit
  warning.
- `sandbox-exec` profile wrapper around the harness process, so filesystem
  confinement holds even if a tool call gets past `canUseTool`.
- Per-session circuit breaker.

Until M3 ships, run agent-relay only for yourself, on your own machine,
with workspaces you're comfortable having the harness process see.
