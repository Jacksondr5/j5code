// @effect-diagnostics nodeBuiltinImport:off - native async skill installation and ownership persistence.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

export const isMissing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export async function skillLinkIdentity(path: string) {
  const stat = await NodeFSP.lstat(path);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.ctimeMs}`;
}

export async function linkDestination(linkPath: string) {
  let stat;
  try {
    stat = await NodeFSP.lstat(linkPath);
  } catch (error) {
    if (isMissing(error)) return { kind: "absent" } as const;
    throw error;
  }
  if (!stat.isSymbolicLink()) return { kind: stat.isDirectory() ? "directory" : "other" } as const;
  const raw = await NodeFSP.readlink(linkPath);
  return { kind: "link", raw, target: NodePath.resolve(NodePath.dirname(linkPath), raw) } as const;
}

/** Resolve parent symlinks even when the skills root does not exist yet. */
export async function canonicalSkillRoot(root: string): Promise<string> {
  try {
    return await NodeFSP.realpath(root);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const seen = await linkDestination(root);
    if (seen.kind !== "absent")
      throw new Error(`Skill root is a broken link: ${root}`, { cause: error });
    return NodePath.join(await canonicalSkillRoot(NodePath.dirname(root)), NodePath.basename(root));
  }
}

/** Finish bounded reads before assembling results or reporting the first error in input order. */
export async function readSkillsConcurrently<A, B>(
  inputs: ReadonlyArray<A>,
  read: (input: A) => Promise<B>,
): Promise<B[]> {
  const results = await Effect.runPromise(
    Effect.forEach(inputs, (input) => Effect.tryPromise(() => read(input)).pipe(Effect.result), {
      concurrency: 8,
    }),
  );
  return results.map((result) => {
    if (result._tag === "Failure") throw result.failure.cause;
    return result.success;
  });
}

export async function writeSkillStateAtomically(file: string, contents: string) {
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
  const staging = NodePath.join(
    NodePath.dirname(file),
    `.${NodePath.basename(file)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  const handle = await NodeFSP.open(staging, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(staging, file);
  } finally {
    await NodeFSP.rm(staging, { force: true });
  }
}
