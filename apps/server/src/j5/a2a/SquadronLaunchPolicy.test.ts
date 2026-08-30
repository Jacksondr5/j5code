import { describe, expect, it } from "vite-plus/test";

import { DV5_NATIVE_COHORTS, resolveSquadronLaunchPolicy } from "./SquadronLaunchPolicy.ts";

describe("resolveSquadronLaunchPolicy", () => {
  it("requires an explicit Squadron for interactive user-origin creation", () => {
    expect(
      resolveSquadronLaunchPolicy({
        createdBy: "user",
        creationSource: "web",
        hasInitialMessage: true,
        sourcePlanHasRegisteredHome: null,
      }),
    ).toEqual({ kind: "require-squadron" });
  });

  it.each([
    ["mobile", "user", true, "mobile-future-squadron"],
    ["server", "system", true, "scheduled-future-context"],
    ["server", "system", false, "system-bootstrap-native"],
  ] as const)(
    "keeps %s/%s in the named native cohort",
    (creationSource, createdBy, hasInitialMessage, cohort) => {
      expect(
        resolveSquadronLaunchPolicy({
          creationSource,
          createdBy,
          hasInitialMessage,
          sourcePlanHasRegisteredHome: null,
        }),
      ).toMatchObject({
        kind: "native-exception",
        cohort,
        returnCondition: DV5_NATIVE_COHORTS[cohort],
      });
    },
  );

  it("keeps a plan child of a legacy no-home parent native without choosing a Squadron", () => {
    expect(
      resolveSquadronLaunchPolicy({
        createdBy: "user",
        creationSource: "web",
        hasInitialMessage: true,
        sourcePlanHasRegisteredHome: false,
      }),
    ).toMatchObject({ kind: "native-exception", cohort: "legacy-plan-child-native" });
  });

  it("requires the Registrar home when a proposed-plan parent is homed", () => {
    expect(
      resolveSquadronLaunchPolicy({
        createdBy: "user",
        creationSource: "web",
        hasInitialMessage: true,
        sourcePlanHasRegisteredHome: true,
      }),
    ).toEqual({ kind: "require-squadron" });
  });

  it("records the untouched agent-spawn bypass as a named legacy return", () => {
    expect(DV5_NATIVE_COHORTS["agent-spawn-native-legacy"]).toContain("spawn_agent");
  });
});
