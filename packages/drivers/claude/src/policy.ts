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
