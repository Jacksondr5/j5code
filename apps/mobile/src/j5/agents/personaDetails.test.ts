import { ProviderInstanceId, type AgentPersonaModelTarget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { personaDetailRows } from "./personaDetails";

const persona = {
  origin: { kind: "folder", path: "/srv/personas/luna.yaml" },
  originLabel: "Folder · personas",
  authority: "Read only (default), Full access",
  description: "Reviews changes.",
  availabilityLabel: "Available",
  blockedReasons: [],
  route: "Codex · gpt-6-luna · primary",
} as unknown as Parameters<typeof personaDetailRows>[0];

const target = (driver: string, model: string, reasoningEffort: string) =>
  ({ driver, model, reasoningEffort }) as unknown as AgentPersonaModelTarget;

const rowsOf = (rows: ReturnType<typeof personaDetailRows>) =>
  rows.map(({ label, value }) => [label, value]);

describe("personaDetailRows", () => {
  it("shows a folder persona's path, access, both models and description", () => {
    expect(
      rowsOf(
        personaDetailRows(
          persona,
          {
            status: "loaded",
            route: [target("codex", "gpt-6-luna", "low"), target("claudeAgent", "haiku", "low")],
          },
          null,
        ),
      ),
    ).toEqual([
      ["Status", "Available"],
      ["Source", "/srv/personas/luna.yaml"],
      ["Access", "Read only (default), Full access"],
      ["Primary model", "Codex · gpt-6-luna · low"],
      ["Fallback model", "Claude · haiku · low"],
      ["Description", "Reviews changes."],
    ]);
  });

  it("shows one canonical model without a duplicate fallback", () => {
    const only = target("codex", "only-model", "high");
    const rows = personaDetailRows(
      persona,
      { status: "loaded", route: [only, only], models: [only] },
      null,
    );
    expect(rows.filter(({ label }) => label.startsWith("Model "))).toEqual([
      { label: "Model 1", value: "Codex · only-model · high" },
    ]);
    expect(rows.map(({ label }) => label)).not.toContain("Fallback model");
  });

  it("shows every canonical instance and option beyond the legacy summary", () => {
    const legacy = target("codex", "first", "high");
    const rows = personaDetailRows(
      persona,
      {
        status: "loaded",
        route: [legacy, legacy],
        models: [
          {
            instanceId: ProviderInstanceId.make("remote-codex"),
            model: "first",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "second",
            options: [{ id: "effort", value: "medium" }],
          },
          {
            instanceId: ProviderInstanceId.make("remote-codex"),
            model: "third",
            options: [{ id: "fastMode", value: true }],
          },
        ],
      },
      null,
    );
    expect(rows.filter(({ label }) => label.startsWith("Model "))).toEqual([
      { label: "Model 1", value: "remote-codex · first · reasoningEffort: high" },
      { label: "Model 2", value: "claudeAgent · second · effort: medium" },
      { label: "Model 3", value: "remote-codex · third · fastMode: true" },
    ]);
  });

  it("falls back to the catalog's route when the definition can't be read", () => {
    const rows = rowsOf(personaDetailRows(persona, { status: "failed" }, null));
    expect(rows).toContainEqual(["Model", "Codex · gpt-6-luna · primary"]);
    expect(rows.map(([label]) => label)).not.toContain("Primary model");
  });

  it("lists every blocked reason in danger text, and usage when there is any", () => {
    const rows = personaDetailRows(
      {
        ...persona,
        availabilityLabel: "Blocked",
        blockedReasons: ["Primary is off", "Fallback is off"],
      },
      { status: "loading" },
      "3 tasks",
    );
    expect(rows.filter(({ tone }) => tone === "danger").map(({ value }) => value)).toEqual([
      "Primary is off",
      "Fallback is off",
    ]);
    expect(rows.at(-1)).toEqual({ label: "Usage", value: "3 tasks" });
  });
});
