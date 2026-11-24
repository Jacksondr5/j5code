import * as Shared from "@t3tools/client-runtime/j5/artifacts";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { ArtifactContent, ArtifactEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { runJ5Command } from "../runCommand";
import { j5Environment } from "../state";

export async function listArtifacts(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<ReadonlyArray<ArtifactEntry>> {
  const result = await runJ5Command(j5Environment.listArtifacts, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value.entries;
}

interface ArtifactReadInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}

// The connection runtime holds the authorization service a key-bound (DPoP) session renews
// through; the app's base runtime has only the signer, so the read must run here.
const readArtifactCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile-j5:read-artifact",
  execute: (input: ArtifactReadInput) =>
    Shared.readArtifact(
      Option.getOrNull(
        appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(input.environmentId)),
      ),
      input,
    ),
});

export async function readArtifact(input: ArtifactReadInput): Promise<ArtifactContent> {
  const result = await runJ5Command(readArtifactCommand, input);
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}
