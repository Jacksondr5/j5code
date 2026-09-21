import { assert, expect, it } from "@effect/vitest";
import { collectFeedback } from "./Feedback.ts";

const receipt = {
  url: "https://github.com/acme/repo/pull/7",
  number: 7,
  commit: "sha",
  draft: true,
  merged: false,
} as const;
const snapshot = (head = "sha") => ({ url: receipt.url, number: 7, headRefOid: head });
const threadPages = (truncated = false) => [
  {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: "thread-1",
                isResolved: true,
                comments: {
                  nodes: [
                    {
                      id: "comment-1",
                      body: "Fix this",
                      url: "https://github.com/acme/repo/pull/7#comment-1",
                    },
                  ],
                  pageInfo: { hasNextPage: truncated },
                },
              },
            ],
          },
        },
      },
    },
  },
];

it("collects paginated comments, reviews, thread resolution and current-head identity without writes", async () => {
  const calls: string[][] = [];
  const result = await collectFeedback(receipt, async (_cwd, executable, args) => {
    assert.equal(executable, "gh");
    calls.push([...args]);
    const output =
      args[0] === "pr"
        ? snapshot()
        : args[1] === "graphql"
          ? threadPages()
          : [[{ id: "first-page" }], [{ id: "second-page" }]];
    return { exitCode: 0, output: JSON.stringify(output) };
  });
  assert.equal(result.commit, receipt.commit);
  assert.include(result.body, "second-page");
  assert.include(result.body, '"isResolved":true');
  assert.deepEqual(result.unknowns, []);
  assert.lengthOf(calls, 5);
  for (const args of calls) {
    if (args[0] === "pr") assert.equal(args[1], "view");
    else {
      assert.include(args, "--paginate");
      assert.include(args, "--slurp");
      if (args[1] === "graphql") assert.include(args.at(-1)!, "query(");
      else assert.notInclude(args, "--method");
    }
  }
});

it("retains an explicit gap when an inline thread exceeds the collection limit", async () => {
  const result = await collectFeedback(receipt, async (_cwd, _executable, args) => ({
    exitCode: 0,
    output: JSON.stringify(
      args[0] === "pr" ? snapshot() : args[1] === "graphql" ? threadPages(true) : [[]],
    ),
  }));
  assert.include(result.unknowns[0]!, "exceeds 100 comments");
});

it("rejects a head change during collection", async () => {
  let views = 0;
  await expect(
    collectFeedback(receipt, async (_cwd, _executable, args) => ({
      exitCode: 0,
      output: JSON.stringify(
        args[0] === "pr"
          ? snapshot(++views === 1 ? "sha" : "changed")
          : args[1] === "graphql"
            ? threadPages()
            : [[]],
      ),
    })),
  ).rejects.toThrow(/PR head changed/);
});

it("fails visibly when GitHub cannot be read or returns incomplete GraphQL data", async () => {
  await expect(
    collectFeedback(receipt, async () => ({ exitCode: 1, output: "not authenticated" })),
  ).rejects.toThrow(/could not be read/);
  await expect(
    collectFeedback(receipt, async (_cwd, _executable, args) => ({
      exitCode: 0,
      output: JSON.stringify(args[0] === "pr" ? snapshot() : []),
    })),
  ).rejects.toThrow(/feedback|Expected|Schema/);
});

it("rejects a malformed receipt before any request", async () => {
  await expect(
    collectFeedback({ ...receipt, number: 8 }, async () => {
      throw new Error("must not call GitHub");
    }),
  ).rejects.toThrow(/Invalid published PR identity/);
});

it("rejects truncated thread pagination and oversized review evidence", async () => {
  const pages = threadPages();
  pages[0]!.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage = true;
  await expect(
    collectFeedback(receipt, async (_cwd, _executable, args) => ({
      exitCode: 0,
      output: JSON.stringify(args[0] === "pr" ? snapshot() : args[1] === "graphql" ? pages : [[]]),
    })),
  ).rejects.toThrow(/incomplete review-thread pages/);
  await expect(
    collectFeedback(receipt, async (_cwd, _executable, args) => ({
      exitCode: 0,
      output: JSON.stringify(
        args[0] === "pr"
          ? snapshot()
          : args[1] === "graphql"
            ? threadPages()
            : [[{ body: "x".repeat(131073) }]],
      ),
    })),
  ).rejects.toThrow(/128 KiB/);
});
