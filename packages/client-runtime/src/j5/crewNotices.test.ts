import { describe, expect, it } from "vite-plus/test";

import { presentCrewContext, withoutHiddenCrewNotices } from "./crewNotices.ts";

const context = (text: string) =>
  `<j5_crew_delivery_context>\n${text}\n</j5_crew_delivery_context>`;
const system = (text: string) => ({ role: "user", createdBy: "system", text });

describe("presentCrewContext", () => {
  it("reads the introduction a member was given, without the wrapper", () => {
    const introduction = "<j5_crew_context>\nYou are reviewer.\n</j5_crew_context>";
    expect(presentCrewContext(system(context(introduction)))).toEqual({
      kind: "introduction",
      title: "Introduction",
      text: introduction,
    });
  });

  it("reads a roster change as its own card", () => {
    const change =
      "<j5_crew_roster_changed>\njoined: security: participant_id=p1 responsibility=audit\n</j5_crew_roster_changed>";
    expect(presentCrewContext(system(context(change)))).toEqual({
      kind: "roster-changed",
      title: "Roster changed",
      text: change,
    });
  });

  it("gives back the closing tag the server escaped inside the text", () => {
    const escaped = context("quoted <\\/j5_crew_delivery_context> inside");
    expect(presentCrewContext(system(escaped))?.text).toBe(
      "quoted </j5_crew_delivery_context> inside",
    );
  });

  it("leaves everything else to the ordinary row", () => {
    const text = context("You are reviewer.");
    expect(presentCrewContext({ role: "user", createdBy: "user", text })).toBeNull();
    expect(presentCrewContext({ role: "assistant", createdBy: "system", text })).toBeNull();
    expect(presentCrewContext(system(`Please read:\n${text}`))).toBeNull();
    expect(presentCrewContext(system(`${text}\n\nReview the fix.`))).toBeNull();
    expect(presentCrewContext(system(context("  ")))).toBeNull();
  });
});

describe("withoutHiddenCrewNotices", () => {
  it("keeps the rows a hidden notice bounded, dropping only that notice's row", () => {
    type Row = { readonly id: string; readonly message?: ReturnType<typeof system> };
    const messageOf = (row: Row) => row.message;
    const visible: ReadonlyArray<Row> = [
      { id: "ask", message: { role: "user", createdBy: "user", text: "Ship it" } },
      { id: "w1" },
    ];
    // Nothing hidden: the same array comes back, so the list's identity check holds.
    expect(withoutHiddenCrewNotices(visible, messageOf)).toBe(visible);
    const rows: ReadonlyArray<Row> = [
      ...visible,
      {
        id: "launch",
        message: system(
          "<j5_seat_finished>\nseat: builder\nparticipant_id: agent:b\nthread_id: thread:b\nrun_status: completed\n</j5_seat_finished>",
        ),
      },
      { id: "reply", message: { role: "assistant", createdBy: "agent", text: "Crew is running." } },
    ];
    const shown = withoutHiddenCrewNotices(rows, messageOf);
    expect(shown.map((entry) => entry.id)).toEqual(["ask", "w1", "reply"]);
    // The same input gives the same output array.
    expect(withoutHiddenCrewNotices(rows, messageOf)).toBe(shown);
  });
});
