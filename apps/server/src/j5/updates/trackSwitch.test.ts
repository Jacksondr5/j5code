import { expect, it } from "@effect/vitest";

import { j5TrackSwitchBlockReason } from "./trackSwitch.ts";

it("re-checks J5's ledgers on the host only when it crosses tracks", () => {
  const nightly = "0.1.4-nightly.20261027.3796";
  const heads = { j5_a2a_migrations: 57 };
  const cross = (
    serverVersion: string,
    targetVersion: string,
    target: Record<string, number> | undefined,
    database: Record<string, number> | undefined,
  ) =>
    j5TrackSwitchBlockReason({
      serverVersion,
      targetVersion,
      targetJ5DatabaseMigrations: target,
      databaseMigrations: () => database,
    });

  expect(cross(nightly, "0.1.4", heads, heads)).toBeNull();
  expect(cross(nightly, "0.1.4", { j5_a2a_migrations: 56 }, heads)).toContain(
    "does not support yet",
  );
  expect(cross(nightly, "0.1.4", undefined, heads)).toContain("Cannot confirm");
  // Staying on a track never needs the check, whatever the heads say.
  expect(cross("0.1.3", "0.1.4", { j5_a2a_migrations: 1 }, heads)).toBeNull();
});
