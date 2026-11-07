// @effect-diagnostics nodeBuiltinImport:off - a random id; no Crypto service is wired into this layer.
import * as NodeCrypto from "node:crypto";
import {
  AgentPersonaCreateInput,
  AgentPersonaEditInput,
  type AgentPersonaAccess,
  type AgentPersonaDraftView,
  type AgentPersonaModelEntry,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import { ParticipantId } from "../a2a/contracts.ts";
import {
  createAgentPersonaLibrary,
  definitionDigest,
  definitionYaml,
  makeAgentPersonaLibrary,
  personaIdInUse,
} from "./agentPersonaLibrary.ts";
import { agentPersonaAccess, type AgentPersonaDefinition } from "./agentPersonas.ts";

/** Why a draft can't be made, asked about, or saved as asked. */
export class AgentPersonaDraftError extends Schema.TaggedError<AgentPersonaDraftError>()(
  "AgentPersonaDraftError",
  { message: Schema.String },
) {}

/** The fields Settings edits; a draft holds them whole, as they would save. */
export interface AgentPersonaDraftFields {
  readonly displayName: string;
  readonly description: string;
  readonly instructions: string;
  readonly access: AgentPersonaAccess;
  readonly modelRoute: ReadonlyArray<AgentPersonaModelEntry>;
  readonly independentReviewer?: boolean;
}

export type AgentPersonaDraftRequest =
  | {
      readonly mode: "create";
      readonly personaId: string;
      readonly fields: AgentPersonaDraftFields;
    }
  | {
      readonly mode: "edit";
      readonly personaId: string;
      readonly expectedDigest: string;
      readonly changes: Partial<AgentPersonaDraftFields>;
    };

/** The two things saving over a team persona means, said the same way everywhere. */
const folderOverrideWarnings = (folderPath: string) => [
  `Saving makes an environment override of the team persona from ${folderPath}: it hides later team updates to this persona for everyone on this server.`,
  "To get the team version back: remove the override, then restore the team persona, both in Settings → Agent Setup.",
];

/** The fixed reply "Save persona" answers an ask with. */
export const savedPersonaReply = (draft: { readonly mode: string; readonly personaId: string }) =>
  draft.mode === "create"
    ? `Saved new persona ${draft.personaId} to this server's library. Launches from now on can use it.`
    : `Saved the edit to persona ${draft.personaId}. Launches from now on run the new version; agents already running keep the one they started with.`;

interface DraftRow {
  readonly id: string;
  readonly proposer_participant_id: string;
  readonly mode: "create" | "edit";
  readonly persona_id: string;
  readonly target_kind: "imported" | "folder" | null;
  readonly base_digest: string | null;
  readonly fields_json: string;
  readonly summary: string;
  readonly exchange_id: string | null;
  readonly status: "open" | "saved";
}

const decodeEdit = Schema.decodeUnknownEffect(AgentPersonaEditInput);
const decodeCreate = Schema.decodeUnknownEffect(AgentPersonaCreateInput);
const FieldsJson = Schema.fromJsonString(
  Schema.Struct({
    displayName: Schema.String,
    description: Schema.String,
    instructions: Schema.String,
    access: Schema.String,
    modelRoute: Schema.Array(Schema.Unknown),
    independentReviewer: Schema.optional(Schema.Boolean),
  }),
);
const encodeFields = Schema.encodeSync(FieldsJson);
const decodeFields = Schema.decodeUnknownEffect(FieldsJson);

const refuse = (message: string) => new AgentPersonaDraftError({ message });

const entryText = (entry: AgentPersonaModelEntry) =>
  "driver" in entry
    ? `${entry.driver} ${entry.model} (${entry.reasoningEffort})`
    : `${entry.instanceId} ${entry.model}${(entry.options ?? []).map(({ id, value }) => ` ${id}=${String(value)}`).join("")}`;
const modelsText = (route: ReadonlyArray<AgentPersonaModelEntry>) =>
  route.map((entry, index) => `${index + 1}. ${entryText(entry)}`).join("; ");
const flagText = (flag: boolean | undefined) => (flag === true ? "on" : "off");

/** Above this many table cells, a changed middle is shown as all removed, then all added. */
const LCS_CELL_LIMIT = 1_000_000;

type DiffOp = { readonly kind: " " | "-" | "+"; readonly line: string };

const middleOps = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<DiffOp> => {
  if ((a.length + 1) * (b.length + 1) > LCS_CELL_LIMIT)
    return [
      ...a.map((line) => ({ kind: "-" as const, line })),
      ...b.map((line) => ({ kind: "+" as const, line })),
    ];
  // Longest common subsequence table, from the end, so the walk below reads forward.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<DiffOp> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      ops.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  return ops;
};

/**
 * The changed lines of `after` against `before`, with one unchanged line of context around each
 * change and `…` for the unchanged runs between.
 */
export const lineDiff = (before: string, after: string): ReadonlyArray<string> => {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const same = (lines: ReadonlyArray<string>) =>
    lines.map((line) => ({ kind: " " as const, line }));
  const ops: ReadonlyArray<DiffOp> = [
    ...same(a.slice(0, head)),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...same(a.slice(a.length - tail)),
  ];
  const changed = (op: DiffOp | undefined) => op !== undefined && op.kind !== " ";
  const lines: Array<string> = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (!changed(op) && !changed(ops[index - 1]) && !changed(ops[index + 1])) {
      skipped = true;
      return;
    }
    if (skipped && lines.length > 0) lines.push("  …");
    skipped = false;
    lines.push(`${op.kind} ${op.line}`);
  });
  return lines;
};

const fieldsOf = (definition: AgentPersonaDefinition, access: AgentPersonaAccess) => ({
  displayName: definition.displayName,
  description: definition.description,
  instructions: definition.instructions,
  access,
  modelRoute: definition.modelRoute,
  ...(definition.independentReviewer === undefined
    ? {}
    : { independentReviewer: definition.independentReviewer }),
});

/** A block of text set off by indentation; the Inbox shows the summary as plain text. */
const indented = (text: string) =>
  text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/** An agent's value, quoted so its own quotes and spacing are visible as written. */
const quoted = (text: string) => JSON.stringify(text);

const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** Whether a persona already has every field a draft would save. */
const sameFields = (
  a: {
    readonly displayName: string;
    readonly description: string;
    readonly instructions: string;
    readonly access: string;
    readonly modelRoute: ReadonlyArray<unknown>;
    readonly independentReviewer?: boolean | undefined;
  },
  b: typeof a,
) =>
  a.displayName === b.displayName &&
  a.description === b.description &&
  a.instructions === b.instructions &&
  a.access === b.access &&
  JSON.stringify(a.modelRoute) === JSON.stringify(b.modelRoute) &&
  (a.independentReviewer === true) === (b.independentReviewer === true);

const changedFields = (before: AgentPersonaDraftFields, after: AgentPersonaDraftFields) => {
  const lines: Array<string> = [];
  if (before.displayName !== after.displayName)
    lines.push(`- Name: ${quoted(before.displayName)} → ${quoted(after.displayName)}`);
  if (before.description !== after.description)
    lines.push(`- Description: ${quoted(before.description)} → ${quoted(after.description)}`);
  if (before.access !== after.access) lines.push(`- Access: ${before.access} → ${after.access}`);
  if (modelsText(before.modelRoute) !== modelsText(after.modelRoute))
    lines.push(
      `- Models, in order: ${modelsText(before.modelRoute)} → ${modelsText(after.modelRoute)}`,
    );
  if (flagText(before.independentReviewer) !== flagText(after.independentReviewer))
    lines.push(
      `- Independent reviewer: ${flagText(before.independentReviewer)} → ${flagText(after.independentReviewer)}`,
    );
  if (before.instructions !== after.instructions) lines.push("- Instructions, line by line below");
  return before.instructions === after.instructions
    ? lines
    : [...lines, indented(lineDiff(before.instructions, after.instructions).join("\n"))];
};

export interface AgentPersonaDraftsShape {
  /** Validate and store a draft; nothing is written to the library. */
  readonly propose: (input: {
    readonly proposerParticipantId: string;
    readonly proposerThreadId: string;
    readonly draft: AgentPersonaDraftRequest;
  }) => Effect.Effect<
    {
      readonly draftId: string;
      readonly summary: string;
      readonly warnings: ReadonlyArray<string>;
    },
    AgentPersonaDraftError | SqlError
  >;
  /**
   * Whether this agent may ask about the draft: its proposer, or the proposer's Captain. A saved
   * draft is not asked about again.
   */
  readonly authorizeAsk: (input: {
    readonly draftId: string;
    readonly askerParticipantId: string;
  }) => Effect.Effect<void, AgentPersonaDraftError | SqlError>;
  /** Link the ask that carries the draft, so the person's Inbox can offer "Save persona". */
  readonly linkAsk: (input: {
    readonly draftId: string;
    readonly exchangeId: string;
  }) => Effect.Effect<void, SqlError>;
  /** The draft each of these asks carries, keyed by exchange id. */
  readonly forExchanges: (
    exchangeIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, AgentPersonaDraftView>, SqlError>;
  /**
   * Write the ask's draft to the library, once; the caller checks the ask is still open. A draft
   * already saved returns as it is, so a retry can still answer the ask.
   */
  readonly save: (input: {
    readonly exchangeId: string;
    readonly savedBy: string;
  }) => Effect.Effect<
    { readonly mode: "create" | "edit"; readonly personaId: string },
    AgentPersonaDraftError | SqlError
  >;
}

export class AgentPersonaDrafts extends Context.Service<
  AgentPersonaDrafts,
  AgentPersonaDraftsShape
>()("t3/j5/agents/agentPersonaDrafts") {}

/** The drafts store over `library`; `layer` uses the server's own. */
export const makeAgentPersonaDrafts = Effect.fn("j5.agents.personaDrafts.make")(function* (
  library: ReturnType<typeof createAgentPersonaLibrary>,
) {
  const sql = yield* SqlClient.SqlClient;
  const crews = yield* AgentCrewInstanceService;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const libraryRefusal = (error: { readonly message: string }) => refuse(error.message);
  const readCatalog = library
    .catalog()
    .pipe(
      Effect.mapError((error) => refuse(`The persona library cannot be read: ${error.message}`)),
    );

  const readDraft = Effect.fn("j5.agents.personaDrafts.read")(function* (draftId: string) {
    const rows = yield* sql<DraftRow>`SELECT * FROM j5_persona_draft WHERE id = ${draftId}`;
    const row = rows[0];
    if (row === undefined)
      return yield* refuse(`There is no persona draft ${draftId} on this server.`);
    return row;
  });

  const propose: AgentPersonaDraftsShape["propose"] = Effect.fn("j5.agents.personaDrafts.propose")(
    function* (input) {
      const { draft } = input;
      const named = draft.mode === "create" ? draft.fields : draft.changes;
      if ([named.displayName, named.description].some((text) => text && LINE_BREAK.test(text)))
        return yield* refuse(
          "A persona's name and description are one line each; only its instructions take line breaks.",
        );
      const current = yield* readCatalog;
      const invalid = (cause: unknown) =>
        refuse(
          `The draft is not a valid persona: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      let targetKind: "imported" | "folder" | null = null;
      let baseDigest: string | null = null;
      let fields: AgentPersonaDraftFields;
      const lines: Array<string> = [];
      const warnings: Array<string> = [];
      if (draft.mode === "create") {
        if (personaIdInUse(current, draft.personaId))
          return yield* refuse(
            `A persona with the id ${draft.personaId} already exists here. Choose another id, or read it with j5_read_persona and propose an edit.`,
          );
        const decoded = yield* decodeCreate({ id: draft.personaId, ...draft.fields }).pipe(
          Effect.mapError(invalid),
        );
        const created = yield* library
          .createdDefinition(decoded)
          .pipe(Effect.mapError(libraryRefusal));
        fields = { ...draft.fields };
        lines.push(
          `J5 recorded this persona draft: a new persona, ${draft.personaId}, for this server's library. Its full definition:`,
          indented(definitionYaml(created).trimEnd()),
        );
      } else {
        const original = current.definitions.find(({ id }) => id === draft.personaId);
        if (original === undefined)
          return yield* refuse(
            current.removedSources.some(({ id }) => id === draft.personaId)
              ? `${draft.personaId} is removed in this environment, and only an Owner restores it, in Settings → Agent Setup.`
              : `There is no persona ${draft.personaId} here. Check j5_list_personas.`,
          );
        if (definitionDigest(original) !== draft.expectedDigest)
          return yield* refuse(
            `${draft.personaId} changed since you read it. Read it again with j5_read_persona and draft the change on the new version.`,
          );
        const access = agentPersonaAccess(original);
        if (access === undefined)
          return yield* refuse(`${draft.personaId} has no valid access to edit from.`);
        const before = fieldsOf(original, access);
        const defined = Object.fromEntries(
          Object.entries(draft.changes).filter(([, value]) => value !== undefined),
        );
        fields = { ...before, ...defined };
        const decoded = yield* decodeEdit({
          personaId: draft.personaId,
          expectedDigest: draft.expectedDigest,
          ...fields,
        }).pipe(Effect.mapError(invalid));
        yield* library.editedDefinition(original, decoded).pipe(Effect.mapError(libraryRefusal));
        const changes = changedFields(before, fields);
        if (changes.length === 0)
          return yield* refuse(`The draft changes nothing in ${draft.personaId}.`);
        targetKind = current.importedIds.includes(draft.personaId) ? "imported" : "folder";
        baseDigest = draft.expectedDigest;
        const folderPath = current.sourcePaths.get(draft.personaId);
        const [list, diff] = [
          changes.filter((line) => line.startsWith("- ")),
          changes.filter((line) => !line.startsWith("- ")),
        ];
        lines.push(
          `J5 recorded this persona draft: an edit of ${draft.personaId} (${quoted(original.displayName)}). Changed fields:\n\n${list.join("\n")}`,
          ...diff,
        );
        if (targetKind === "folder" && folderPath !== undefined)
          warnings.push(...folderOverrideWarnings(folderPath));
      }
      const summary = [
        ...lines,
        ...warnings,
        "Saving takes an Owner's Save persona button on this ask, in the web or desktop app; a typed reply asks for changes and saves nothing.",
      ].join("\n\n");
      const draftId = `persona-draft-${NodeCrypto.randomUUID()}`;
      yield* sql`
          INSERT INTO j5_persona_draft (
            id, proposer_participant_id, proposer_thread_id, mode, persona_id, target_kind,
            base_digest, fields_json, summary, status, created_at
          ) VALUES (
            ${draftId}, ${input.proposerParticipantId}, ${input.proposerThreadId}, ${draft.mode},
            ${draft.personaId}, ${targetKind}, ${baseDigest}, ${encodeFields(fields)}, ${summary},
            'open', ${yield* now}
          )
        `;
      return { draftId, summary, warnings };
    },
  );

  const authorizeAsk: AgentPersonaDraftsShape["authorizeAsk"] = Effect.fn(
    "j5.agents.personaDrafts.authorizeAsk",
  )(function* (input) {
    const row = yield* readDraft(input.draftId);
    if (row.proposer_participant_id !== input.askerParticipantId) {
      const membership = yield* crews.findMembership(
        ParticipantId.make(row.proposer_participant_id),
      );
      const crew = membership === null ? null : yield* crews.read(membership.crewInstanceId);
      if (crew?.captainParticipantId !== input.askerParticipantId)
        return yield* refuse(
          `Persona draft ${input.draftId} is another agent's. Ask about your own drafts, or, as a Captain, your Crew members'.`,
        );
    }
    if (row.status === "saved")
      return yield* refuse(`Persona draft ${input.draftId} is already saved.`);
  });

  const linkAsk: AgentPersonaDraftsShape["linkAsk"] = (input) =>
    sql`
        UPDATE j5_persona_draft SET exchange_id = ${input.exchangeId} WHERE id = ${input.draftId}
      `.pipe(Effect.asVoid);

  const forExchanges: AgentPersonaDraftsShape["forExchanges"] = Effect.fn(
    "j5.agents.personaDrafts.forExchanges",
  )(function* (exchangeIds) {
    if (exchangeIds.length === 0) return new Map();
    const rows = yield* sql<DraftRow>`
        SELECT * FROM j5_persona_draft WHERE ${sql.in("exchange_id", exchangeIds)}
      `;
    return new Map(
      rows.map((row) => [
        row.exchange_id!,
        {
          draftId: row.id,
          personaId: row.persona_id,
          mode: row.mode,
          overridesFolder: row.target_kind === "folder",
          status: row.status,
          summary: row.summary,
        },
      ]),
    );
  });

  const save: AgentPersonaDraftsShape["save"] = Effect.fn("j5.agents.personaDrafts.save")(
    function* (input) {
      const rows = yield* sql<DraftRow>`
          SELECT * FROM j5_persona_draft WHERE exchange_id = ${input.exchangeId}
        `;
      const row = rows[0];
      if (row === undefined) return yield* refuse("This ask doesn't carry a persona draft.");
      const saved = { mode: row.mode, personaId: row.persona_id };
      if (row.status === "saved") return saved;
      const fields = yield* decodeFields(row.fields_json).pipe(
        Effect.mapError(() => refuse(`Persona draft ${row.id} can't be read.`)),
      );
      const current = yield* readCatalog;
      const markSaved = Effect.gen(function* () {
        yield* sql`
          UPDATE j5_persona_draft
          SET status = 'saved', saved_by = ${input.savedBy}, saved_at = ${yield* now}
          WHERE id = ${row.id}
        `;
        return saved;
      });
      // A save that wrote the library but died before marking the draft: its retry finds the
      // persona already in effect with exactly these fields, and finishes instead of refusing.
      const inEffect = current.definitions.find(({ id }) => id === row.persona_id);
      const inEffectAccess = inEffect === undefined ? undefined : agentPersonaAccess(inEffect);
      if (
        inEffect !== undefined &&
        inEffectAccess !== undefined &&
        current.importedIds.includes(row.persona_id) &&
        sameFields(fieldsOf(inEffect, inEffectAccess), fields)
      )
        return yield* markSaved;
      const stale = (why: string) =>
        refuse(
          `${row.persona_id} ${why} since the agent drafted this, so nothing was saved. Ask the agent to read it again and draft the change anew.`,
        );
      if (row.mode === "create") {
        if (personaIdInUse(current, row.persona_id)) return yield* stale("was created");
        const decoded = yield* decodeCreate({ id: row.persona_id, ...fields }).pipe(
          Effect.mapError(() => refuse(`Persona draft ${row.id} is no longer valid.`)),
        );
        yield* library.createPersona(decoded).pipe(Effect.mapError(libraryRefusal));
      } else {
        const original = current.definitions.find(({ id }) => id === row.persona_id);
        const kind = current.importedIds.includes(row.persona_id) ? "imported" : "folder";
        if (
          original === undefined ||
          kind !== row.target_kind ||
          definitionDigest(original) !== row.base_digest
        )
          return yield* stale(original === undefined ? "was removed" : "changed");
        const decoded = yield* decodeEdit({
          personaId: row.persona_id,
          expectedDigest: row.base_digest,
          ...fields,
        }).pipe(Effect.mapError(() => refuse(`Persona draft ${row.id} is no longer valid.`)));
        yield* (
          kind === "imported" ? library.editImported(decoded) : library.overrideSource(decoded)
        ).pipe(Effect.mapError(libraryRefusal));
      }
      return yield* markSaved;
    },
  );

  return AgentPersonaDrafts.of({ propose, authorizeAsk, linkAsk, forExchanges, save });
});

export const layer = Layer.effect(
  AgentPersonaDrafts,
  makeAgentPersonaLibrary.pipe(Effect.flatMap(makeAgentPersonaDrafts)),
);
