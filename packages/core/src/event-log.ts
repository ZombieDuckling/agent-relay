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
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean);
    const events: RelayEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      try {
        const parsed = JSON.parse(lines[i]);
        const event = RelayEventSchema.parse(parsed);
        events.push(event);
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`EventLog: invalid event at ${this.path}:${lineNo}: ${cause}`);
      }
    }
    return events;
  }

  readSession(sid: string): RelayEvent[] {
    return this.readAll().filter(e => e.session_id === sid);
  }
}
