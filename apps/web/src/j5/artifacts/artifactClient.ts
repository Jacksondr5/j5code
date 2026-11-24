import * as Shared from "@t3tools/client-runtime/j5/artifacts";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { ArtifactContent, ArtifactEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { connectionAtomRuntime } from "../../connection/runtime";
import { readPreparedConnection } from "../../state/session";
import { j5Environment } from "../state";
import { runJ5Command } from "../runCommand";

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
  label: "web-j5:read-artifact",
  execute: (input: ArtifactReadInput) =>
    Shared.readArtifact(readPreparedConnection(input.environmentId), input),
});

export async function readArtifact(input: ArtifactReadInput): Promise<ArtifactContent> {
  const result = await runJ5Command(readArtifactCommand, input);
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

/** Permanently delete one artifact on the environment that holds the project. */
export async function deleteArtifact(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly path: string;
}): Promise<void> {
  const result = await runJ5Command(j5Environment.deleteArtifact, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId, path: input.path },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
}

/** Permanently delete all artifacts on the environment that holds the project. */
export async function deleteAllArtifacts(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}): Promise<void> {
  const result = await runJ5Command(j5Environment.deleteAllArtifacts, {
    environmentId: input.environmentId,
    input: { projectId: input.projectId },
  });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
}
