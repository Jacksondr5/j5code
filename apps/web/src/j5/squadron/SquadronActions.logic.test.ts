import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeSquadronDeleteFailure,
  dropDraftStatesForDeletedSquadron,
  resolveScopeAfterSquadronDelete,
  resolveSquadronActionsState,
  resolveSquadronRenameState,
} from "./SquadronActions.logic";

const remote = EnvironmentId.make("remote");
const local = EnvironmentId.make("local");
const alpha = { environmentId: remote, squadronId: "squadron:alpha" };

describe("resolveSquadronActionsState", () => {
  it("hides rename and delete while All Squadrons is the scope", () => {
    expect(resolveSquadronActionsState(null)).toEqual({ kind: "hidden" });
  });

  it("disables the actions for a Squadron whose environment cannot operate", () => {
    expect(resolveSquadronActionsState({ available: false }).kind).toBe("disabled");
  });

  it("offers the actions for the selected Squadron on a ready environment", () => {
    expect(resolveSquadronActionsState({ available: true })).toEqual({ kind: "ready" });
  });
});

describe("resolveSquadronRenameState", () => {
  it("rejects a blank or whitespace-only name", () => {
    expect(resolveSquadronRenameState({ draftName: "   ", currentName: "Alpha" }).kind).toBe(
      "missing-name",
    );
  });

  it("treats a trimmed name equal to the current name as unchanged", () => {
    expect(resolveSquadronRenameState({ draftName: " Alpha ", currentName: "Alpha" })).toEqual({
      kind: "unchanged",
    });
  });

  it("submits the trimmed name", () => {
    expect(resolveSquadronRenameState({ draftName: "  Bravo ", currentName: "Alpha" })).toEqual({
      kind: "ready",
      name: "Bravo",
    });
  });
});

describe("resolveScopeAfterSquadronDelete", () => {
  it("falls back to All Squadrons when the deleted Squadron was the ambient scope", () => {
    expect(resolveScopeAfterSquadronDelete(alpha, alpha)).toBeNull();
  });

  it("keeps a scope that points elsewhere, including the same id on another environment", () => {
    const other = { environmentId: local, squadronId: "squadron:alpha" };
    expect(resolveScopeAfterSquadronDelete(other, alpha)).toBe(other);
    expect(resolveScopeAfterSquadronDelete(null, alpha)).toBeNull();
  });
});

describe("dropDraftStatesForDeletedSquadron", () => {
  const carrier = { squadronId: "squadron:alpha", frozenAtFirstSend: false, content: null };
  const bravo = { squadronId: "squadron:bravo", frozenAtFirstSend: false, content: null };

  it("drops carriers on the deleted Squadron's environment only", () => {
    const next = dropDraftStatesForDeletedSquadron(
      { "remote:thread-1": carrier, "local:thread-2": carrier, "remote:thread-3": bravo },
      alpha,
    );
    expect(Object.keys(next)).toEqual(["local:thread-2", "remote:thread-3"]);
  });

  it("returns the same record when no carrier pointed at the deleted Squadron", () => {
    const states = { "remote:thread-3": bravo };
    expect(dropDraftStatesForDeletedSquadron(states, alpha)).toBe(states);
  });
});

describe("describeSquadronDeleteFailure", () => {
  it("surfaces the server's 409 message verbatim as a refusal", () => {
    const refusal = Object.assign(new Error("Test still has 2 live members and 1 live Crew."), {
      status: 409,
    });
    expect(describeSquadronDeleteFailure(refusal)).toEqual({
      kind: "refused",
      message: "Test still has 2 live members and 1 live Crew.",
    });
  });

  it("reports other errors as failures with a fallback message", () => {
    expect(describeSquadronDeleteFailure(new Error("The environment is disconnected."))).toEqual({
      kind: "failed",
      message: "The environment is disconnected.",
    });
    expect(describeSquadronDeleteFailure("boom")).toEqual({
      kind: "failed",
      message: "Could not delete the Squadron.",
    });
  });
});
