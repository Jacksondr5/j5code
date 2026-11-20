import * as Schema from "effect/Schema";

/** Only server-to-server handoffs carry this summary. The source prompt stays on its server. */
export const PlaybookOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unscheduled") }),
  Schema.Struct({
    kind: Schema.Literal("scheduled"),
    names: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/))),
  }),
  Schema.Struct({ kind: Schema.Literal("unverified") }),
]);
export type PlaybookOrigin = typeof PlaybookOrigin.Type;
