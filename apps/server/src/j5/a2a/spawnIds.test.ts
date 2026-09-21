import { describe, expect, it } from "vite-plus/test";

import { crewSeatRequestKey, spawnThreadId } from "./spawnIds.ts";

describe("spawn thread ids", () => {
  it("keeps terminal history filenames bounded and retries deterministic", () => {
    const input = {
      providerSessionId: "j5-crew-proposal",
      requestKey: crewSeatRequestKey("crew:" + "long%3Aproposal/".repeat(200), "reviewer"),
    };
    const id = spawnThreadId(input);
    expect(spawnThreadId(input)).toBe(id);
    expect(Buffer.byteLength(`terminal_${Buffer.from(id).toString("base64url")}.log`)).toBeLessThan(
      255,
    );
    expect(spawnThreadId({ ...input, requestKey: input.requestKey + "-2" })).not.toBe(id);
    expect(spawnThreadId({ ...input, providerSessionId: "another-session" })).not.toBe(id);
    expect(spawnThreadId({ providerSessionId: "a:b", requestKey: "c" })).not.toBe(
      spawnThreadId({ providerSessionId: "a", requestKey: "b:c" }),
    );
  });
});
