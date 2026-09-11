import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { ManagedSquadron } from "@t3tools/contracts/j5";
import type { J5ReadSource } from "@t3tools/client-runtime/j5/readSources";
import { mergeSquadronSources } from "@t3tools/client-runtime/j5/squadrons";

const alpha: ManagedSquadron = {
  squadron: { id: "squadron:alpha", name: "Alpha", createdAt: "2026-08-30T00:00:00Z" },
  projectIds: [ProjectId.make("project:alpha")],
};
const source = (
  id: string,
  data: ReadonlyArray<ManagedSquadron>,
  overrides: Partial<J5ReadSource<ReadonlyArray<ManagedSquadron>>> = {},
): J5ReadSource<ReadonlyArray<ManagedSquadron>> => ({
  environmentId: EnvironmentId.make(id),
  environmentLabel: id,
  connected: true,
  canOperate: true,
  status: "ready",
  data,
  error: null,
  refreshing: false,
  ...overrides,
});

describe("Squadron directory across environments", () => {
  it("uses remote Squadrons when the primary server has none", () => {
    const result = mergeSquadronSources({
      isReady: true,
      sources: [source("primary", []), source("remote", [alpha])],
    });
    expect(result.status).toBe("ready");
    expect(result.squadrons).toMatchObject([
      { environmentId: "remote", available: true, squadron: { id: alpha.squadron.id } },
    ]);
  });

  it("keeps the selected directory during an outage while another environment remains usable", () => {
    const result = mergeSquadronSources({
      isReady: true,
      sources: [
        source("primary", [alpha], { status: "offline", connected: false, canOperate: false }),
        source("remote", [alpha]),
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.squadrons.map((entry) => [entry.environmentId, entry.available])).toEqual([
      ["primary", false],
      ["remote", true],
    ]);
  });

  it("does not declare the only loaded Squadron to be the only Squadron while a source is pending", () => {
    const result = mergeSquadronSources({
      isReady: true,
      sources: [
        source("primary", [], { status: "loading", data: null }),
        source("remote", [alpha]),
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.squadrons).toHaveLength(1);
  });

  it("does not turn failed or unsupported reads into first-run creation", () => {
    expect(
      mergeSquadronSources({
        isReady: true,
        sources: [source("remote", [], { status: "error", data: null })],
      }).status,
    ).toBe("error");
    expect(
      mergeSquadronSources({
        isReady: true,
        sources: [source("remote", [], { status: "unsupported", data: null })],
      }).status,
    ).toBe("error");
  });
});
