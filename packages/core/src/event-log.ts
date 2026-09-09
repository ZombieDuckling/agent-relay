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
