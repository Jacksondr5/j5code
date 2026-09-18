import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type * as Handoff from "@j5/playbook-contracts/fh";
import { command } from "./GitWorkspace.ts";

const decodeIdentity = Schema.decodeUnknownSync(
  Schema.Struct({
    url: Schema.String,
    number: Schema.Number,
    headRefOid: Schema.String,
  }),
);
const decodeRestPages = Schema.decodeUnknownSync(Schema.Array(Schema.Array(Schema.Unknown)));
const decodeThreadPages = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      errors: Schema.optional(Schema.Array(Schema.Unknown)),
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            reviewThreads: Schema.Struct({
              pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
              nodes: Schema.Array(
                Schema.Struct({
                  comments: Schema.Struct({
                    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
                  }),
                }),
              ),
            }),
          }),
        }),
      }),
    }),
  ),
);
const threadsQuery = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { id url body createdAt author { login } commit { oid } }
          }
        }
      }
    }
  }
}`;

/** Read-only GitHub intake; the persona needs no network or publication authority. */
export async function collectFeedback(
  receipt: typeof Handoff.PullRequestResult.Type,
  read = command,
) {
  const url = new URL(receipt.url);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
  if (url.protocol !== "https:" || !match || Number(match[3]) !== receipt.number)
    throw new Error("Invalid published PR identity");
  const [, owner, name] = match;
  const repo = `${url.hostname}/${owner}/${name}`;
  const json = async (args: string[]): Promise<unknown> => {
    const result = await read("/", "gh", args);
    if (result.exitCode !== 0)
      throw new Error(`GitHub feedback could not be read: ${result.output}`);
    return JSON.parse(result.output);
  };
  const view = () =>
    json([
      "pr",
      "view",
      String(receipt.number),
      "--repo",
      repo,
      "--json",
      "url,number,headRefOid,baseRefOid,state,isDraft,reviewDecision,statusCheckRollup",
    ]);
  const requireIdentity = (value: unknown) => {
    const identity = decodeIdentity(value);
    if (
      identity.url !== receipt.url ||
      identity.number !== receipt.number ||
      identity.headRefOid !== receipt.commit
    )
      throw new Error("PR head changed since publication; review the new head before continuing");
  };
  const pullRequest = await view();
  requireIdentity(pullRequest);
  const pages = async (path: string) => {
    const result = await json(["api", "--hostname", url.hostname, path, "--paginate", "--slurp"]);
    return decodeRestPages(result).flat();
  };
  const comments = await pages(`repos/${owner}/${name}/issues/${receipt.number}/comments`);
  const reviews = await pages(`repos/${owner}/${name}/pulls/${receipt.number}/reviews`);
  const threads = await json([
    "api",
    "graphql",
    "--hostname",
    url.hostname,
    "--paginate",
    "--slurp",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
    "-F",
    `number=${receipt.number}`,
    "-f",
    `query=${threadsQuery}`,
  ]);
  const decoded = decodeThreadPages(threads);
  if (decoded.length === 0) throw new Error("GitHub feedback is missing review-thread pages");
  if (
    decoded.some((page) => page.errors?.length) ||
    decoded.at(-1)!.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage
  )
    throw new Error("GitHub feedback returned incomplete review-thread pages");
  const unknowns = decoded.some((page) =>
    page.data.repository.pullRequest.reviewThreads.nodes.some(
      (thread) => thread.comments.pageInfo.hasNextPage,
    ),
  )
    ? [
        "At least one inline thread exceeds 100 comments; its remaining comments were not collected.",
      ]
    : [];
  requireIdentity(await view());
  const body = JSON.stringify({ pullRequest, comments, reviews, threads });
  if (Buffer.byteLength(body, "utf8") > 131072)
    throw new Error("PR feedback exceeds the 128 KiB intake limit");
  return {
    url: receipt.url,
    commit: receipt.commit,
    collectedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    body,
    unknowns,
  };
}
