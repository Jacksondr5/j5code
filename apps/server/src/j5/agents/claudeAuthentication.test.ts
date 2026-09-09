import { describe, expect, it } from "@effect/vitest";
import { claudeAuthenticationStatus } from "./claudeAuthentication.ts";

describe("Claude authentication evidence", () => {
  it.each([
    ['{"loggedIn":true,"authMethod":"claude.ai"}', 0, "authenticated"],
    ['{"loggedIn":true,"apiProvider":"bedrock"}', 0, "authenticated"],
    ['{"loggedIn":false}', 1, "unauthenticated"],
    ['{"loggedIn":false}', 0, "unauthenticated"],
    ['{"loggedIn":true}', 1, "unknown"],
    ['{"loggedIn":"true"}', 0, "unknown"],
    ['{"email":"previous@example.com"}', 0, "unknown"],
    ["not json", 0, "unknown"],
  ])("interprets %s with exit %s as %s", (stdout, code, expected) => {
    expect(claudeAuthenticationStatus({ stdout, code, stderr: "" })).toBe(expected);
  });

  it("does not infer login when the probe fails", () => {
    expect(claudeAuthenticationStatus(undefined)).toBe("unknown");
  });
});
