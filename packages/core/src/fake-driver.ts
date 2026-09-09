import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Driver, DriverEvent, RunOptions } from "./driver.js";

export class FakeDriver implements Driver {
  readonly name = "fake";

  async *run(o: RunOptions): AsyncIterable<DriverEvent> {
    yield { type: "init", harness_session_id: `fake-${Date.now()}` };
    yield { type: "message", role: "assistant", text: `ok: ${o.prompt}` };
    const file = "hello.txt";
    yield { type: "tool", name: "Write", input: { file_path: join(o.workspace, file) } };
    writeFileSync(join(o.workspace, file), "hello\n");
    yield { type: "artifact", path: file };
    yield { type: "result", subtype: "success", num_turns: 1, duration_ms: 1 };
  }
}
