import { z } from "zod";

export const EventKind = z.enum([
  "session.created", "run.started", "message", "tool.called", "tool.denied",
  "artifact.written", "context.injected", "run.finished", "session.cancelled",
]);
export type EventKind = z.infer<typeof EventKind>;

export const RelayEventSchema = z.object({
  id: z.string().regex(/^evt_/),
  ts: z.string().datetime(),
  session_id: z.string().min(1),
  run: z.number().int().nonnegative().optional(),
  kind: EventKind,
  data: z.record(z.unknown()),
});
export type RelayEvent = z.infer<typeof RelayEventSchema>;
export type NewEvent = Omit<RelayEvent, "id" | "ts">;
