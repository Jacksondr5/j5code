// @effect-diagnostics nodeBuiltinImport:off - drives git against a throwaway bare repository.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  EvidenceRefusal,
  assertPng,
  evidencePath,
  evidenceTable,
  githubRepository,
  parseEvidenceArgs,
  pushEvidence,
  rawUrl,
  stageEvidence,
} from "./pr-evidence.ts";

// The script commits with the machine's git identity; a CI runner may have none.
process.env.GIT_AUTHOR_NAME ??= "Test";
process.env.GIT_AUTHOR_EMAIL ??= "test@example.invalid";
process.env.GIT_COMMITTER_NAME ??= "Test";
process.env.GIT_COMMITTER_EMAIL ??= "test@example.invalid";

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" });

/** A bare repository with an `evidence` branch, standing in for the real remote. */
function makeRemote() {
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "j5-pr-evidence-test-"));
  const remote = NodePath.join(base, "remote.git");
  const seed = NodePath.join(base, "seed");
  NodeFS.mkdirSync(remote);
  git(remote, "init", "--bare", "--initial-branch", "evidence");
  NodeFS.mkdirSync(seed);
  git(seed, "init", "--initial-branch", "evidence");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.invalid");
  git(seed, "config", "commit.gpgsign", "false");
  NodeFS.writeFileSync(NodePath.join(seed, "README.md"), "evidence\n");
  git(seed, "add", "--all");
  git(seed, "commit", "--message", "start");
  git(seed, "push", remote, "evidence");
  const image = (name: string, bytes: Buffer = PNG) => {
    const file = NodePath.join(base, name);
    NodeFS.writeFileSync(file, bytes);
    return file;
  };
  return { base, remote, seed, image };
}

const cloneDirFor = (base: string, name: string) => NodePath.join(base, name);

describe("parseEvidenceArgs", () => {
  it("reads the pull request, each pair and a missing before", () => {
    assert.deepEqual(
      parseEvidenceArgs([
        "551",
        "--pair",
        "Empty state",
        "a.png",
        "b.png",
        "--pair",
        "New",
        "-",
        "c.png",
      ]),
      {
        pullRequest: 551,
        pairs: [
          { caption: "Empty state", before: "a.png", after: "b.png" },
          { caption: "New", before: undefined, after: "c.png" },
        ],
        remote: undefined,
        branch: "j5/evidence",
      },
    );
  });

  it("refuses a missing number, no pairs, a short pair and a pair with no after", () => {
    for (const args of [
      [],
      ["abc", "--pair", "x", "a.png", "b.png"],
      ["551"],
      ["551", "--pair", "x", "a.png"],
      ["551", "--pair", "x", "a.png", "-"],
      ["551", "--video", "x.mp4"],
    ]) {
      assert.throws(() => parseEvidenceArgs(args), EvidenceRefusal);
    }
  });
});

describe("links and names", () => {
  it("knows a GitHub remote in either form, and nothing else", () => {
    assert.equal(githubRepository("https://github.com/Jacksondr5/j5code.git"), "Jacksondr5/j5code");
    assert.equal(githubRepository("git@github.com:Jacksondr5/j5code.git"), "Jacksondr5/j5code");
    assert.isUndefined(githubRepository("/tmp/remote.git"));
  });

  it("builds the raw link in the refs/heads form", () => {
    assert.equal(
      rawUrl("Jacksondr5/j5code", "j5/evidence", "pr-7/01-x-after-abcdef12.png"),
      "https://raw.githubusercontent.com/Jacksondr5/j5code/refs/heads/j5/evidence/pr-7/01-x-after-abcdef12.png",
    );
  });

  it("names a file by order, caption, side and content, so a changed image gets a new name", () => {
    const name = (sha256: string) =>
      evidencePath({
        pullRequest: 7,
        index: 0,
        caption: "Empty state (dark)!",
        side: "after",
        sha256,
      });
    assert.equal(name("abcdef1234"), "pr-7/01-empty-state-dark-after-abcdef12.png");
    assert.notEqual(name("abcdef1234"), name("1234abcdef"));
  });

  it("prints one row per pair, with a missing before said plainly", () => {
    assert.equal(
      evidenceTable(
        [
          { caption: "Empty", before: "pr-7/a.png", after: "pr-7/b.png" },
          { caption: "New | state", before: undefined, after: "pr-7/c.png" },
        ],
        (path) => `https://x/${path}`,
      ),
      [
        "| | Before | After |",
        "| --- | --- | --- |",
        "| Empty | ![Empty, before](https://x/pr-7/a.png) | ![Empty, after](https://x/pr-7/b.png) |",
        "| New \\| state | did not exist | ![New | state, after](https://x/pr-7/c.png) |",
      ].join("\n"),
    );
  });
});

describe("assertPng", () => {
  it("accepts a PNG and refuses other bytes under a .png name", () => {
    const { base, image } = makeRemote();
    assertPng(image("real.png"));
    // JPEG magic bytes, as a screenshot tool sometimes writes them.
    const jpeg = image(
      "fake.png",
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]),
    );
    assert.throws(() => assertPng(jpeg), /not a PNG/);
    assert.throws(() => assertPng(NodePath.join(base, "missing.png")), /does not exist/);
    NodeFS.rmSync(base, { recursive: true, force: true });
  });
});

describe("publishing to a branch", () => {
  it("puts the images under pr-<number>/ and pushes them", () => {
    const { base, remote, image } = makeRemote();
    const cloneDir = cloneDirFor(base, "clone");
    const request = {
      pullRequest: 7,
      pairs: [{ caption: "Empty state", before: image("before.png"), after: image("after.png") }],
      remote,
      branch: "evidence",
    };
    const published = stageEvidence({ request, remote, cloneDir });
    pushEvidence(cloneDir, "evidence");

    const files = git(remote, "ls-tree", "-r", "--name-only", "evidence").trim().split("\n");
    assert.includeMembers(files, [
      published[0]?.before ?? "",
      published[0]?.after ?? "",
      "README.md",
    ]);
    assert.match(published[0]?.after ?? "", /^pr-7\/01-empty-state-after-[0-9a-f]{8}\.png$/);
    assert.equal(
      git(remote, "log", "-1", "--format=%s", "evidence").trim(),
      "evidence: screenshots for #7",
    );

    // The same images again change nothing and still succeed.
    const again = cloneDirFor(base, "again");
    assert.deepEqual(stageEvidence({ request, remote, cloneDir: again }), published);
    pushEvidence(again, "evidence");
    assert.equal(git(remote, "rev-list", "--count", "evidence").trim(), "2");
    NodeFS.rmSync(base, { recursive: true, force: true });
  });

  it("rebases onto another agent's push and keeps both", () => {
    const { base, remote, seed, image } = makeRemote();
    const cloneDir = cloneDirFor(base, "clone");
    const request = {
      pullRequest: 8,
      pairs: [{ caption: "Mine", before: undefined, after: image("mine.png") }],
      remote,
      branch: "evidence",
    };
    const published = stageEvidence({ request, remote, cloneDir });
    // Another agent pushes between this clone and this push.
    NodeFS.mkdirSync(NodePath.join(seed, "pr-9"));
    NodeFS.writeFileSync(NodePath.join(seed, "pr-9/theirs.png"), PNG);
    git(seed, "add", "--all");
    git(seed, "commit", "--message", "theirs");
    git(seed, "push", remote, "evidence");

    pushEvidence(cloneDir, "evidence");
    const files = git(remote, "ls-tree", "-r", "--name-only", "evidence").trim().split("\n");
    assert.includeMembers(files, ["pr-9/theirs.png", published[0]?.after ?? ""]);
    NodeFS.rmSync(base, { recursive: true, force: true });
  });
});
