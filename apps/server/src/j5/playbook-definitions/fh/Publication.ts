import * as Schema from "effect/Schema";
import type * as Handoff from "@j5/playbook-contracts/fh";
import { candidate, command, git } from "./GitWorkspace.ts";

const decodePullRequests = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      url: Schema.String,
      number: Schema.Number,
      isDraft: Schema.Boolean,
      mergedAt: Schema.NullOr(Schema.String),
      headRefOid: Schema.String,
      state: Schema.String,
    }),
  ),
);

type Metadata = typeof Handoff.PublicationMetadata.Type;
export interface GitHub {
  readonly find: (metadata: Metadata) => Promise<{
    url: string;
    number: number;
    draft: boolean;
    merged: boolean;
    commit: string;
    closed: boolean;
  } | null>;
  readonly create: (metadata: Metadata) => Promise<void>;
  readonly update: (metadata: Metadata, number: number) => Promise<void>;
}
export const github: GitHub = {
  async find(metadata) {
    const result = await command("/", "gh", [
      "pr",
      "list",
      "--repo",
      metadata.repository,
      "--head",
      metadata.headBranch,
      "--base",
      metadata.baseBranch,
      "--state",
      "all",
      "--json",
      "url,number,isDraft,mergedAt,headRefOid,state",
    ]);
    if (result.exitCode !== 0) throw new Error(result.output);
    const rows = decodePullRequests(JSON.parse(result.output));
    if (rows.length > 1) throw new Error("Multiple pull requests exist for the playbook branch");
    const row = rows[0];
    return row
      ? {
          url: row.url,
          number: row.number,
          draft: row.isDraft,
          merged: row.mergedAt !== null,
          commit: row.headRefOid,
          closed: row.state !== "OPEN",
        }
      : null;
  },
  async create(metadata) {
    const result = await command("/", "gh", [
      "pr",
      "create",
      "--draft",
      "--repo",
      metadata.repository,
      "--base",
      metadata.baseBranch,
      "--head",
      metadata.headBranch,
      "--title",
      metadata.title,
      "--body",
      metadata.body,
    ]);
    if (result.exitCode !== 0) throw new Error(result.output);
  },
  async update(metadata, number) {
    const result = await command("/", "gh", [
      "pr",
      "edit",
      String(number),
      "--repo",
      metadata.repository,
      "--title",
      metadata.title,
      "--body",
      metadata.body,
    ]);
    if (result.exitCode !== 0) throw new Error(result.output);
  },
};

export async function verifyCandidate(worktree: string, baseCommit: string, metadata: Metadata) {
  if ((await git(worktree, ["branch", "--show-current"])) !== metadata.headBranch)
    throw new Error("Approved branch changed");
  const current = await candidate(worktree, baseCommit);
  if (current.codeIdentity !== metadata.codeIdentity || current.tree !== metadata.tree)
    throw new Error("Approved code changed");
}
export async function commit(worktree: string, baseCommit: string, metadata: Metadata) {
  await verifyCandidate(worktree, baseCommit, metadata);
  const parent = metadata.parentCommit ?? baseCommit;
  await git(worktree, ["merge-base", "--is-ancestor", baseCommit, parent]);
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  if (head !== parent) {
    if (
      (await git(worktree, ["show", "-s", "--format=%P", "HEAD"])) !== parent ||
      (await git(worktree, ["rev-parse", "HEAD^{tree}"])) !== metadata.tree ||
      (await git(worktree, ["log", "-1", "--format=%B"])) !== metadata.commitMessage.trim()
    ) {
      throw new Error("Existing commit does not match publication approval");
    }
    return { commit: head, codeIdentity: metadata.codeIdentity };
  }
  if ((await git(worktree, ["rev-parse", `${parent}^{tree}`])) === metadata.tree)
    throw new Error("There are no approved changes to commit");
  // This index belongs exclusively to the playbook worktree. Populate the exact approved tree.
  await git(worktree, ["read-tree", metadata.tree]);
  if ((await git(worktree, ["write-tree"])) !== metadata.tree)
    throw new Error("Staged tree does not match approval");
  await verifyCandidate(worktree, baseCommit, metadata);
  await git(worktree, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    metadata.commitMessage,
  ]);
  const result = await git(worktree, ["rev-parse", "HEAD"]);
  if ((await git(worktree, ["rev-parse", "HEAD^{tree}"])) !== metadata.tree)
    throw new Error("Committed tree changed");
  return { commit: result, codeIdentity: metadata.codeIdentity };
}
export async function push(worktree: string, baseCommit: string, metadata: Metadata, sha: string) {
  await verifyCandidate(worktree, baseCommit, metadata);
  if ((await git(worktree, ["rev-parse", "HEAD"])) !== sha)
    throw new Error("Approved commit changed");
  if ((await git(worktree, ["remote", "get-url", "origin"])) !== metadata.repository)
    throw new Error("Approved remote changed");
  const ref = `refs/heads/${metadata.headBranch}`;
  let remote = (await git(worktree, ["ls-remote", "origin", ref])).split(/\s/)[0] || undefined;
  const previous = metadata.parentCommit === baseCommit ? undefined : metadata.parentCommit;
  if (remote !== sha && remote !== previous)
    throw new Error("Remote branch has an unexpected commit");
  if (remote !== sha) await git(worktree, ["push", "origin", `${sha}:${ref}`]);
  remote = (await git(worktree, ["ls-remote", "origin", ref])).split(/\s/)[0];
  if (remote !== sha) throw new Error("Push could not be confirmed");
  return { commit: sha, remoteSha: sha };
}
export async function draft(metadata: Metadata, sha: string, api: GitHub) {
  let pr = await api.find(metadata);
  if (!pr) {
    await api.create(metadata);
    pr = await api.find(metadata);
  }
  if (!pr || !pr.draft || pr.merged || pr.closed || pr.commit !== sha)
    throw new Error("Draft PR does not match approval");
  await api.update(metadata, pr.number);
  const updated = await api.find(metadata);
  if (
    !updated ||
    updated.number !== pr.number ||
    !updated.draft ||
    updated.merged ||
    updated.closed ||
    updated.commit !== sha
  )
    throw new Error("Draft PR changed while updating publication metadata");
  return {
    commit: sha,
    url: pr.url,
    number: pr.number,
    draft: true as const,
    merged: false as const,
  };
}
