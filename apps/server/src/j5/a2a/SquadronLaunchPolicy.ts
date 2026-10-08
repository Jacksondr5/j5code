import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { listSquadronReferencesForProject } from "./SquadronProjectReferences.ts";

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

export class ScheduledLaunchSharedProjectError extends Schema.TaggedError<ScheduledLaunchSharedProjectError>()(
  "ScheduledLaunchSharedProjectError",
  { projectId: Schema.String, squadronCount: Schema.Number },
) {
  override get message(): string {
    return `Project ${this.projectId} is shared by ${this.squadronCount} Squadrons, and a scheduled task cannot choose between them, so no thread was started. Bind the task to an existing thread, or leave the project with one Squadron.`;
  }
}

/**
 * A scheduled new-thread run sends no Squadron, so its thread joins its
 * project's. When several Squadrons reference the project the launch would be
 * refused only after the thread exists; this refuses first, so a recurring
 * task does not leave a homeless thread behind on every fire.
 */
export const refuseScheduledLaunchIntoSharedProject = Effect.fn(
  "j5.a2a.refuseScheduledLaunchIntoSharedProject",
)(function* (sql: SqlClient.SqlClient, projectId: ProjectId) {
  const references = yield* listSquadronReferencesForProject(sql, projectId);
  if (references.length > 1) {
    return yield* new ScheduledLaunchSharedProjectError({
      projectId,
      squadronCount: references.length,
    });
  }
});

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
 * DV5's closed, named noninteractive cohort table. `require-squadron` launches
 * register a home: the Squadron they send, or else their project's Squadron
 * (`SquadronThreadCreationService`). The native cohorts stay without a home
 * only until the ledger re-keys to projects (#412), when every thread
 * registers at creation; the exemption is not permanent.
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
