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
