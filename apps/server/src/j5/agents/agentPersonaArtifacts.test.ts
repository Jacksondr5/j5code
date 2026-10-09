import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  AGENT_ARTIFACT_TEMPLATES,
  agentHandoffArtifactPath,
  agentHandoffTaskSegment,
  agentPersonaArtifactInstructions,
} from "./agentPersonaArtifacts.ts";
import { BUILT_IN_AGENT_PERSONAS } from "./agentPersonas.ts";

const threadId = ThreadId.make("8f3a2c1d-0000-4000-8000-000000000000");

describe("saved-agent handoff artifacts", () => {
  it("names one file per task, grouped by agent", () => {
    expect(
      agentHandoffArtifactPath({ personaId: "critic", artifact: "ReviewHandoff", threadId }),
    ).toBe("handoffs/critic/ReviewHandoff-8f3a2c1d.md");
  });

  it("hashes deterministic platform thread ids so seats get distinct, colon-free file names", () => {
    const seatA = ThreadId.make("thread:j5:a2a:mcp:j5-crew-proposal:spawn:seat-a");
    const seatB = ThreadId.make("thread:j5:a2a:mcp:j5-crew-proposal:spawn:seat-b");
    const a = agentHandoffArtifactPath({
      personaId: "critic",
      artifact: "ReviewHandoff",
      threadId: seatA,
    });
    const b = agentHandoffArtifactPath({
      personaId: "critic",
      artifact: "ReviewHandoff",
      threadId: seatB,
    });
    expect(a).toMatch(/^handoffs\/critic\/ReviewHandoff-[0-9a-f]{8}\.md$/);
    expect(b).toMatch(/^handoffs\/critic\/ReviewHandoff-[0-9a-f]{8}\.md$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(":");
    expect(agentHandoffTaskSegment(seatA)).toBe(agentHandoffTaskSegment(seatA));
    expect(agentHandoffTaskSegment(threadId)).toBe("8f3a2c1d");
  });

  it("tells a persona where to write its declared output and what it must contain", () => {
    const section = agentPersonaArtifactInstructions(BUILT_IN_AGENT_PERSONAS.critic, threadId);
    expect(section).toContain("## Handoff artifacts");
    expect(section).toContain("`handoffs/critic/ReviewHandoff-8f3a2c1d.md`");
    expect(section).toContain("write_artifact");
    for (const item of AGENT_ARTIFACT_TEMPLATES.ReviewHandoff!) expect(section).toContain(item);
    expect(section).toContain("marks the handoff missing");
  });

  it("covers declared inputs, custom artifact names, and personas without artifacts", () => {
    const withInputs = agentPersonaArtifactInstructions(
      { id: "builder", inputArtifacts: ["PlanHandoff"], outputArtifact: "CodeCompleteHandoff" },
      threadId,
    );
    expect(withInputs).toContain("`PlanHandoff`");
    expect(withInputs).toContain("read_artifact");
    const custom = agentPersonaArtifactInstructions(
      { id: "team", inputArtifacts: [], outputArtifact: "TeamBrief" },
      threadId,
    );
    expect(custom).toContain("What was asked and the scope you covered.");
    expect(
      agentPersonaArtifactInstructions({ id: "plain", inputArtifacts: [] }, threadId),
    ).toBeUndefined();
  });
});
