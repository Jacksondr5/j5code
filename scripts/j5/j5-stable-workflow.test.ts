// @effect-diagnostics nodeBuiltinImport:off - reads the workflow files beside this repository's scripts.
import * as NodeFS from "node:fs";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

const Workflow = Schema.Struct({
  on: Schema.Struct({
    workflow_call: Schema.optional(
      Schema.Struct({
        outputs: Schema.optional(
          Schema.Record(Schema.String, Schema.Struct({ value: Schema.String })),
        ),
      }),
    ),
  }),
  jobs: Schema.Record(Schema.String, Schema.Struct({ if: Schema.optional(Schema.String) })),
});

const readWorkflow = (name: string) =>
  Schema.decodeSync(fromYaml(Workflow))(
    NodeFS.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"),
  );

type Result = "success" | "failure" | "cancelled" | "skipped";

// Enough of GitHub's expression syntax for these conditions: contexts, quoted strings, ! && || == !=.
const evaluate = (expression: string, context: Record<string, unknown>): unknown => {
  const body = expression
    .replace(/^\$\{\{|\}\}$/g, "")
    .replace(/([!=])=/g, "$1==")
    .trim();
  return new Function(...Object.keys(context), `return (${body});`)(...Object.values(context));
};

const stable = readWorkflow("j5-stable.yml");
const release = readWorkflow("j5-release.yml");

// What J5 Release hands J5 Stable as `needs.release.outputs.published`.
const releasePublished = (jobs: {
  resolvePublished: "true" | "false";
  releasePublished: "true" | "";
}) => {
  const value = release.on.workflow_call?.outputs?.published?.value;
  if (value === undefined) return "";
  return String(
    evaluate(value, {
      jobs: {
        resolve: { outputs: { published: jobs.resolvePublished } },
        release: { outputs: { published: jobs.releasePublished } },
      },
    }),
  );
};

const bumps = (run: {
  releaseResult: Result;
  resolvePublished: "true" | "false";
  releasePublished: "true" | "";
  dryRun: boolean;
}) => {
  const needs = {
    resolve: { result: "success" as Result, outputs: {} },
    release: { result: run.releaseResult, outputs: { published: releasePublished(run) } },
  };
  return evaluate(stable.jobs.version_bump?.if ?? "", {
    needs,
    inputs: { dry_run: run.dryRun },
    cancelled: () => false,
    failure: () => Object.values(needs).some((job) => job.result === "failure"),
  });
};

describe("J5 Stable's version bump", () => {
  it("pushes the bump only once the release is published", () => {
    expect(
      bumps({
        releaseResult: "success",
        resolvePublished: "false",
        releasePublished: "true",
        dryRun: false,
      }),
    ).toBe(true);
    // A cancelled macOS job skips J5 Release's publish job; the caller's result is not a failure.
    for (const releaseResult of ["success", "skipped", "cancelled"] as const) {
      expect(
        bumps({ releaseResult, resolvePublished: "false", releasePublished: "", dryRun: false }),
      ).toBe(false);
    }
    // A re-dispatch of a version that is already published skips every release job.
    for (const releaseResult of ["success", "skipped"] as const) {
      expect(
        bumps({ releaseResult, resolvePublished: "true", releasePublished: "", dryRun: false }),
      ).toBe(true);
    }
    expect(
      bumps({
        releaseResult: "success",
        resolvePublished: "false",
        releasePublished: "",
        dryRun: true,
      }),
    ).toBe(false);
    expect(
      bumps({
        releaseResult: "skipped",
        resolvePublished: "true",
        releasePublished: "",
        dryRun: true,
      }),
    ).toBe(false);
  });
});
