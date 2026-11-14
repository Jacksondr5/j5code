import {
  withoutHiddenCrewNotices as withoutHidden,
  type CrewNoticeMessage,
} from "@t3tools/client-runtime/j5/crew-notices";

/** The timeline's message rows without the hidden Crew notices (FORK.md case 104). */
export const withoutHiddenCrewNotices = <Row extends { readonly kind: string }>(
  rows: Array<Row>,
): Array<Row> =>
  withoutHidden(rows, (row) =>
    row.kind === "message" && "message" in row ? (row.message as CrewNoticeMessage) : undefined,
  );
