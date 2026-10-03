import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "../servicePreflight.ts";
import { parseServiceState, SERVICE_LAUNCHER_PROTOCOL } from "../serviceProtocol.ts";

// The executable's rename from `t3` to `j5` is launcher protocol 4. A server
// from before it can't finish the update from the app; `j5 update` on its
// machine does, and these are the two things that path relies on.

it("tells a pre-rename server to finish the update with j5 update", () => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: 3,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.3",
    reason:
      "This update changes how the background service starts. Run `j5 update` on the server's machine to finish it.",
  });
});

it("starts from the state file a pre-rename j5 update leaves behind", () => {
  // The old CLI writes protocol 3, then starts the new launcher.
  expect(parseServiceState('{"protocol":3,"activeVersion":"1.2.3"}')).toEqual({
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: "1.2.3",
  });
  expect(parseServiceState('{"protocol":2,"activeVersion":"1.2.3"}')).toBeUndefined();
});
