import type { OrchestrationV2Actor, OrchestrationV2CreationSource } from "@t3tools/contracts";

/**
 * DV5's closed native/nonparticipant table. The agent-spawn row is an
 * intentionally un-routed legacy gap: OrchestratorMcp's `delegate_task`
 * bypass does not reach ThreadLaunch and returns through A2's spawn verb.
 */
export const DV5_NATIVE_COHORTS = {
  "mobile-future-squadron": "Return with the future mobile-Squadron creation surface.",
  "system-bootstrap-native": "Permanently native system-bootstrap cohort.",
  "legacy-plan-child-native":
    "Return when legacy proposed-plan parents can be explicitly registered before child creation.",
  "agent-spawn-native-legacy":
    "Return through A2's spawn_agent verb; do not route OrchestratorMcp delegate_task through this launch policy.",
} as const;

export const DV5_SCHEDULED_NEW_THREAD_POLICY = {
  kind: "unsupported-refused" as const,
  message:
    "Scheduled new-thread execution is unsupported until scheduling context can select an explicit existing Squadron.",
  returnCondition: "Return with future scheduling context selection.",
};

export type SquadronLaunchPolicy =
  | { readonly kind: "require-squadron" }
  | {
      readonly kind: "native-exception";
      readonly cohort:
        | "mobile-future-squadron"
        | "system-bootstrap-native"
        | "legacy-plan-child-native";
      readonly returnCondition: (typeof DV5_NATIVE_COHORTS)[
        | "mobile-future-squadron"
        | "system-bootstrap-native"
        | "legacy-plan-child-native"];
    };

/**
 * DV5's closed, named noninteractive cohort table. Interactive user-origin
 * creation is the only route that must supply a Squadron now; this does not
 * choose or infer one for any native cohort.
 */
export const resolveSquadronLaunchPolicy = (input: {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly hasInitialMessage: boolean;
  readonly sourcePlanHasRegisteredHome: boolean | null;
}): SquadronLaunchPolicy => {
  if (input.creationSource === "mobile") {
    return {
      kind: "native-exception",
      cohort: "mobile-future-squadron",
      returnCondition: DV5_NATIVE_COHORTS["mobile-future-squadron"],
    };
  }
  if (
    input.createdBy === "system" &&
    input.creationSource === "server" &&
    !input.hasInitialMessage
  ) {
    return {
      kind: "native-exception",
      cohort: "system-bootstrap-native",
      returnCondition: DV5_NATIVE_COHORTS["system-bootstrap-native"],
    };
  }
  if (input.sourcePlanHasRegisteredHome === false) {
    return {
      kind: "native-exception",
      cohort: "legacy-plan-child-native",
      returnCondition: DV5_NATIVE_COHORTS["legacy-plan-child-native"],
    };
  }
  return { kind: "require-squadron" };
};
