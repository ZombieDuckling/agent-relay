# agent-relay

A daemon on your laptop/server that exposes your existing, subscription-backed agent harnesses (Claude Code, Codex, Hermes) through an API so your own apps can create sessions, inject context, add tools, and stream results—without owning the agent loop or paying API rates. Architecture inspired by T3 Code (server owns sessions/workspaces; clients talk over one authenticated RPC WebSocket; provider processes never run in the client). Internal-use only.

**Status: M0 scaffold**

See the design spec: [docs/superpowers/specs/2026-09-09-agent-relay-design.md](docs/superpowers/specs/2026-09-09-agent-relay-design.md)
