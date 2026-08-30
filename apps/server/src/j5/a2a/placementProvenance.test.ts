import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { ParticipantId } from "./contracts.ts";
import { provenanceFromThreadLineage } from "./placementProvenance.ts";

const parentThreadId = ThreadId.make("thread:parent");
const parentParticipantId = ParticipantId.make("agent:parent");

it("discriminates delegated, forked, and ordinary provenance from immutable lineage", () => {
  const delegated = provenanceFromThreadLineage({
    lineage: { parentThreadId, relationshipToParent: "subagent" },
    parentParticipantId,
  });
  const forked = provenanceFromThreadLineage({
    lineage: { parentThreadId, relationshipToParent: "fork" },
    parentParticipantId,
  });
  const ordinary = provenanceFromThreadLineage({
    lineage: { parentThreadId: null, relationshipToParent: null },
    // A caller timeline may identify who invoked create_threads, but ordinary
    // lineage remains root and must win over that non-authoritative breadcrumb.
    parentParticipantId,
  });

  assert.deepStrictEqual(delegated, {
    kind: "spawned-by",
    spawnedByParticipantId: parentParticipantId,
    source: "upstream_lineage",
  });
  assert.deepStrictEqual(forked, {
    kind: "forked-from",
    sourceParticipantId: parentParticipantId,
    source: "upstream_lineage",
  });
  assert.deepStrictEqual(ordinary, {
    kind: "unknown",
    source: "native_or_unobserved",
  });
  assert.notEqual(forked.kind, "spawned-by");
  assert.notEqual(ordinary.kind, "spawned-by");
});
