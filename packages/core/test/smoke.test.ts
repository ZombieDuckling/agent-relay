import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";
test("core exports version", () => { expect(VERSION).toBe("0.0.1"); });
