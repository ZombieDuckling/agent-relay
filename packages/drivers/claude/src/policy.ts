import { resolve, relative, isAbsolute, dirname, sep } from "node:path";
import { realpathSync, existsSync } from "node:fs";

// NOTE on Bash gating: the Bash allowlist/denylist below is a heuristic regex
// scan over raw shell text. It is NOT a sound security boundary — it can be
// bypassed by encoding, indirection, or shell features we didn't anticipate.
// The real control is the M3 sandbox-exec wrapper (planned), which confines
// the process itself regardless of what the command string says. Until that
// lands, Bash is denied by default and only enabled via `opts.allowBash`.

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

// Tools that are inert/in-process and never touch the filesystem: allowed
// unconditionally.
const READ_ONLY_ALLOW = new Set(["TodoWrite"]);

// Tools that read the filesystem via a `path` argument: path-scoped, same as
// FILE_TOOLS. When `path` is absent or empty we allow (the harness defaults
// it to `cwd`, which is the session workspace).
const PATH_SCOPED_READ_TOOLS = new Set(["Glob", "Grep", "LS"]);

// `Task` spawns a subagent whose own tool calls may not re-enter this
// `canUseTool` hook, so it cannot be treated as read-only. Denied until that
// is verified against the SDK.

// Explicitly denied regardless of allowlist status (kept for clarity/documentation;
// these already fail default-deny since they're not in READ_ONLY_ALLOW).
const DENY_TOOLS = new Set(["WebFetch", "WebSearch"]);

const BASH_FORBIDDEN = [
  /~\//,
  /\/Users\/[^ ]+\/\.(ssh|aws|gnupg|config)/,
  /\/etc\//,
  /\$HOME/,
  /\/home\//,
  /\/private\//,
  /\/var\/root\//,
  /\/root\//,
  /`/,
  /\$\(/,
  /\beval\b/,
];

/**
 * Resolve the canonical (symlink-free) real path of `p`. If `p` does not
 * exist yet (e.g. Write creating a new file), walk up to the nearest
 * existing ancestor, realpath that, and re-join the remaining segments.
 */
function canonicalize(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) {
    return realpathSync.native(abs);
  }
  // Walk up until we find the nearest existing ancestor directory, collecting
  // the missing trailing segments along the way.
  const remainder: string[] = [];
  let dir = abs;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root and still nothing exists
    remainder.unshift(dir.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    dir = parent;
  }
  const realDir = realpathSync.native(dir);
  return resolve(realDir, ...remainder);
}

function inside(workspace: string, p: string): boolean {
  let canonicalWorkspace: string;
  let canonicalTarget: string;
  try {
    canonicalWorkspace = canonicalize(workspace);
  } catch {
    // Workspace itself doesn't exist and has no existing ancestor (shouldn't
    // normally happen) — fall back to lexical resolution so we don't crash.
    canonicalWorkspace = resolve(workspace);
  }
  try {
    canonicalTarget = canonicalize(p);
  } catch {
    return false;
  }
  const rel = relative(canonicalWorkspace, canonicalTarget);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function decideToolUse(
  workspace: string,
  toolName: string,
  input: unknown,
  opts?: { allowBash?: boolean }
): { allow: true } | { allow: false; reason: string } {
  const inp = (input ?? {}) as Record<string, unknown>;

  if (DENY_TOOLS.has(toolName)) {
    return { allow: false, reason: `${toolName} disabled by relay policy` };
  }

  if (FILE_TOOLS.has(toolName)) {
    const raw = inp.file_path ?? inp.notebook_path;
    if (typeof raw !== "string" || raw.length === 0) {
      return { allow: false, reason: "missing file_path" };
    }
    return inside(workspace, raw) ? { allow: true } : { allow: false, reason: `path outside workspace: ${raw}` };
  }

  if (toolName === "Bash") {
    if (opts?.allowBash !== true) {
      return { allow: false, reason: "Bash disabled by relay policy (set allowBash)" };
    }
    const cmd = String(inp.command ?? "");
    const hit = BASH_FORBIDDEN.find(r => r.test(cmd));
    return hit ? { allow: false, reason: `command references protected path` } : { allow: true };
  }

  if (READ_ONLY_ALLOW.has(toolName)) {
    return { allow: true };
  }

  if (PATH_SCOPED_READ_TOOLS.has(toolName)) {
    const raw = inp.path;
    if (typeof raw !== "string" || raw.length === 0) {
      return { allow: true };
    }
    return inside(workspace, raw) ? { allow: true } : { allow: false, reason: `path outside workspace: ${raw}` };
  }

  return { allow: false, reason: `tool not in relay allowlist: ${toolName}` };
}
