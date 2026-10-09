import { assert, describe, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import { codexApplicationContext } from "./codexApplicationContext.ts";

describe("codexApplicationContext", () => {
  it("spreads J5's orchestration text over numbered keys that each fit Codex's entry cap", () => {
    const entries = codexApplicationContext(
      "t3_code_orchestration",
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    );
    const keys = Object.keys(entries);

    assert.isAbove(keys.length, 1);
    assert.deepEqual(
      keys,
      keys.map((_, index) =>
        index === 0 ? "t3_code_orchestration" : `t3_code_orchestration_${index + 1}`,
      ),
    );
    for (const entry of Object.values(entries)) {
      assert.equal(entry.kind, "application");
      assert.isAtMost(Buffer.byteLength(entry.value), 3_600);
    }
    assert.equal(
      Object.values(entries)
        .map((entry) => entry.value)
        .join("\n"),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
    );
  });

  it("keeps short text in the one given key and sends nothing for no text", () => {
    assert.deepEqual(codexApplicationContext("j5_agent_persona", "  Builder instructions\n"), {
      j5_agent_persona: { kind: "application", value: "Builder instructions" },
    });
    assert.deepEqual(codexApplicationContext("j5_agent_persona", undefined), {});
    assert.deepEqual(codexApplicationContext("j5_agent_persona", "  \n"), {});
  });
});
