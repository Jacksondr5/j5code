import { OrchestrationV2AgentPersonaAssignment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ServerProvider } from "@t3tools/contracts";
import {
  AgentPersonaLibraryError,
  type createAgentPersonaLibrary,
} from "../agents/agentPersonaLibrary.ts";
import { prepareAgentPersonaLaunch } from "../agents/agentPersonaLaunch.ts";

export const playbookAuthorities = {
  scout: "read-only",
  navigator: "read-only",
  advocate: "read-only",
  skeptic: "read-only",
  builder: "workspace-write",
  critic: "critic-review",
  sentry: "read-only",
} as const;
export const PlaybookRole = Schema.Literals(
  Object.keys(playbookAuthorities) as [
    keyof typeof playbookAuthorities,
    ...Array<keyof typeof playbookAuthorities>,
  ],
);
export const PlaybookExecution = Schema.Struct({
  stateRoot: Schema.String,
  personas: Schema.Record(Schema.String, OrchestrationV2AgentPersonaAssignment),
  definition: Schema.optional(
    Schema.Struct({
      source: Schema.String,
      runtime: Schema.String,
    }),
  ),
});
type PersonaAssignment = typeof OrchestrationV2AgentPersonaAssignment.Type;
export type PlaybookExecution = Omit<typeof PlaybookExecution.Type, "personas"> & {
  readonly personas: Readonly<Record<string, PersonaAssignment>> &
    Readonly<Record<keyof typeof playbookAuthorities, PersonaAssignment>>;
};
const decodeExecution = Schema.decodeUnknownSync(PlaybookExecution);
export const readPlaybookExecution = (value: unknown) =>
  decodeExecution(value) as PlaybookExecution;
const isPlaybookExecution = Schema.is(PlaybookExecution);
export const legacyPlaybookMessage =
  "This playbook has no complete persona snapshots. Start a fresh task to continue.";
export const hasPlaybookSnapshots = (execution: unknown): boolean => {
  if (!isPlaybookExecution(execution)) return false;
  const assignments = Object.values(execution.personas);
  if (!assignments.length || assignments.some((assignment) => !assignment.definitionDigest))
    return false;
  if (execution.definition) return true;
  return Object.entries(playbookAuthorities).every(
    ([role, authority]) =>
      execution.personas[role]?.personaId === role &&
      execution.personas[role]?.authorityPolicy === authority,
  );
};

/** One catalog read binds the entire run, including roles first used in later phases. */
export const preparePlaybookExecution = Effect.fn("Playbook.prepareExecution")(function* (
  stateRoot: string,
  library: ReturnType<typeof createAgentPersonaLibrary>,
  providers: ReadonlyArray<ServerProvider>,
  requested: Readonly<
    Record<
      string,
      { readonly persona: string; readonly authority: PersonaAssignment["authorityPolicy"] }
    >
  > = Object.fromEntries(
    Object.entries(playbookAuthorities).map(([persona, authority]) => [
      persona,
      { persona, authority },
    ]),
  ),
  definition?: { readonly source: string; readonly runtime: string },
) {
  const catalog = yield* library.catalog();
  const capturedLibrary = { ...library, catalog: () => Effect.succeed(catalog) };
  const personas: {
    -readonly [K in keyof PlaybookExecution["personas"]]?: PlaybookExecution["personas"][K];
  } = {};
  for (const [assignmentKey, requestedAssignment] of Object.entries(requested)) {
    const { persona: personaId, authority: authorityPolicy } = requestedAssignment;
    const assignment = yield* prepareAgentPersonaLaunch(
      { personaId, authorityPolicy },
      providers,
      capturedLibrary,
    );
    if (!assignment.definitionDigest)
      return yield* new AgentPersonaLibraryError({
        message: "Playbook persona snapshot was not saved.",
      });
    personas[assignmentKey] = assignment;
  }
  return readPlaybookExecution({ stateRoot, personas, ...(definition ? { definition } : {}) });
});
