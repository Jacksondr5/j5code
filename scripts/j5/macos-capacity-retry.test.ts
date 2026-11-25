import { describe, expect, it } from "vite-plus/test";

import {
  decideCapacityRetry,
  isEventCurrent,
  MAX_ATTEMPTS,
  MAX_WATCHES,
  runRetryLoop,
  type RunAttempt,
  type RunJob,
} from "./macos-capacity-retry.ts";

const NOT_ACQUIRED =
  "The job was not acquired by Runner of type hosted even after multiple attempts";
const EXIT_1 = "Process completed with exit code 1.";

const job = (
  name: string,
  conclusion: string,
  labels: string,
  failures: string[] = [],
): RunJob => ({
  name,
  conclusion,
  labels: [labels],
  failures,
});

const CLI_MAC = "Release / CLI archive darwin-arm64";
const DMG = "Release / Desktop build / Signed and notarized Apple Silicon DMG";
const WINDOWS = "Release / windows / Windows x64 CLI archive and installer";
const BUMP = "Push the version bump for j5/main";

const nightly = (overrides: Record<string, RunJob>) =>
  [
    job("Resolve the nightly version", "success", "ubuntu-24.04"),
    job("Release / resolve", "success", "ubuntu-24.04"),
    job(CLI_MAC, "success", "macos-15"),
    job(DMG, "success", "macos-15"),
    job("Release / CLI archive linux-x64", "success", "ubuntu-24.04"),
    job(WINDOWS, "success", "windows-2025"),
    job("Release / release", "skipped", "ubuntu-24.04"),
  ].map((entry) => overrides[entry.name] ?? entry);

const stable = (attempt: number, overrides: Record<string, RunJob>): RunAttempt => ({
  completed: true,
  conclusion: "failure",
  attempt,
  jobs: [...nightly(overrides), overrides[BUMP] ?? job(BUMP, "success", "ubuntu-24.04")],
});

describe("decideCapacityRetry", () => {
  it.each([
    {
      run: "both macOS jobs not picked up (45603621283)",
      jobs: nightly({
        [CLI_MAC]: job(CLI_MAC, "cancelled", "macos-15", [NOT_ACQUIRED]),
        [DMG]: job(DMG, "cancelled", "macos-15", [NOT_ACQUIRED]),
      }),
      rerun: true,
    },
    {
      run: "the CLI archive not picked up, the DMG built",
      jobs: nightly({ [CLI_MAC]: job(CLI_MAC, "cancelled", "macos-15", [NOT_ACQUIRED]) }),
      rerun: true,
    },
    {
      run: "a larger hosted macOS label not picked up",
      jobs: nightly({ [DMG]: job(DMG, "cancelled", "macos-latest-xlarge", [NOT_ACQUIRED]) }),
      rerun: true,
    },
    {
      run: "both macOS jobs failed in their own steps (45107797516)",
      jobs: nightly({
        [CLI_MAC]: job(CLI_MAC, "failure", "macos-15", [EXIT_1]),
        [DMG]: job(DMG, "failure", "macos-15", [EXIT_1]),
        [WINDOWS]: job(WINDOWS, "failure", "windows-2025", [EXIT_1]),
      }),
      rerun: false,
    },
    {
      run: "a macOS job not picked up beside a failed Windows job (45383247803)",
      jobs: nightly({
        [CLI_MAC]: job(CLI_MAC, "cancelled", "macos-15", [NOT_ACQUIRED]),
        [WINDOWS]: job(WINDOWS, "failure", "windows-2025", [EXIT_1]),
      }),
      rerun: false,
    },
    {
      run: "a macOS job cancelled without the capacity annotation",
      jobs: nightly({ [DMG]: job(DMG, "cancelled", "macos-15") }),
      rerun: false,
    },
    {
      run: "a capacity annotation with other error text",
      jobs: nightly({
        [DMG]: job(DMG, "cancelled", "macos-15", [`${NOT_ACQUIRED}. ${EXIT_1}`]),
      }),
      rerun: false,
    },
    {
      run: "a non-macOS job carrying the capacity annotation",
      jobs: nightly({ [WINDOWS]: job(WINDOWS, "cancelled", "windows-2025", [NOT_ACQUIRED]) }),
      rerun: false,
    },
    {
      run: "a self-hosted label that only contains macos",
      jobs: nightly({ [DMG]: job(DMG, "cancelled", "build-macos-assets", [NOT_ACQUIRED]) }),
      rerun: false,
    },
  ])("$run: rerun $rerun", ({ jobs, rerun }) => {
    expect(
      decideCapacityRetry({ completed: true, conclusion: "failure", attempt: 1, jobs }).rerun,
    ).toBe(rerun);
  });

  it("re-runs a stable promotion that keeps losing macOS jobs until the attempt cap", () => {
    const lost = {
      [CLI_MAC]: job(CLI_MAC, "cancelled", "macos-15", [NOT_ACQUIRED]),
      [DMG]: job(DMG, "cancelled", "macos-15", [NOT_ACQUIRED]),
    };
    const decisions = [1, 2, 3, 4, 5].map((attempt) => decideCapacityRetry(stable(attempt, lost)));
    expect(decisions.map((decision) => decision.rerun)).toEqual([true, true, true, true, false]);
    expect(decisions[4]?.reason).toContain(`cap of ${MAX_ATTEMPTS}`);
  });

  it("never re-runs a version bump that failed on its own (45258474262, attempt 2)", () => {
    const decision = decideCapacityRetry(
      stable(2, {
        [CLI_MAC]: job(CLI_MAC, "cancelled", "macos-15", [NOT_ACQUIRED]),
        [BUMP]: job(BUMP, "failure", "ubuntu-24.04", [
          EXIT_1,
          "j5/release-0.0.53 already exists. Open or merge its pull request, or delete the branch and re-run this job.",
        ]),
      }),
    );
    expect(decision).toEqual({ rerun: false, reason: expect.stringContaining(BUMP) });
  });
});

describe("isEventCurrent", () => {
  it.each([
    { run: { status: "completed", run_attempt: 3 }, eventAttempt: 2, current: false },
    { run: { status: "in_progress", run_attempt: 2 }, eventAttempt: 2, current: false },
    { run: { status: "queued", run_attempt: 3 }, eventAttempt: 2, current: false },
    { run: { status: "completed", run_attempt: 2 }, eventAttempt: 2, current: true },
  ])("attempt $eventAttempt with latest $run.run_attempt $run.status: $current", (row) => {
    expect(isEventCurrent(row.run, row.eventAttempt)).toBe(row.current);
  });
});

describe("runRetryLoop", () => {
  const lost = {
    [CLI_MAC]: job(CLI_MAC, "cancelled", "macos-15", [NOT_ACQUIRED]),
    [DMG]: job(DMG, "cancelled", "macos-15", [NOT_ACQUIRED]),
  };
  const succeeded = (attempt: number): RunAttempt => ({
    completed: true,
    conclusion: "success",
    attempt,
    jobs: nightly({}),
  });
  const running = (attempt: number): RunAttempt => ({
    completed: false,
    conclusion: null,
    attempt,
    jobs: nightly({}),
  });

  // `reads` is what each successive read of the latest attempt returns.
  const fakeGh = (reads: ReadonlyArray<RunAttempt>) => {
    const calls: string[] = [];
    let next = 0;
    return {
      calls,
      gh: {
        readLatest: () => {
          const run = reads[next++];
          if (!run) throw new Error("read past the last attempt");
          calls.push(`read ${run.attempt}${run.completed ? "" : " running"}`);
          return run;
        },
        rerunFailed: () => {
          calls.push("rerun");
        },
        waitForRun: () => {
          calls.push("wait");
        },
      },
    };
  };

  it("re-runs and waits until an attempt is not lost to capacity", () => {
    const { calls, gh } = fakeGh([stable(1, lost), stable(2, lost), succeeded(3)]);
    const decision = runRetryLoop("1", gh, () => {});
    expect(calls).toEqual(["read 1", "rerun", "wait", "read 2", "rerun", "wait", "read 3"]);
    expect(decision.rerun).toBe(false);
  });

  it("waits again when the wait ends before the new attempt completes", () => {
    const { calls, gh } = fakeGh([stable(1, lost), stable(1, lost), running(2), succeeded(2)]);
    const decision = runRetryLoop("1", gh, () => {});
    expect(calls).toEqual([
      "read 1",
      "rerun",
      "wait",
      "read 1",
      "wait",
      "read 2 running",
      "wait",
      "read 2",
    ]);
    expect(decision.reason).toContain("conclusion is success");
  });

  it("stops at the attempt cap", () => {
    const { calls, gh } = fakeGh([1, 2, 3, 4, 5].map((attempt) => stable(attempt, lost)));
    const decision = runRetryLoop("1", gh, () => {});
    expect(calls.filter((call) => call === "rerun")).toHaveLength(MAX_ATTEMPTS - 1);
    expect(calls.at(-1)).toBe(`read ${MAX_ATTEMPTS}`);
    expect(decision.reason).toContain(`cap of ${MAX_ATTEMPTS}`);
  });

  it.each([
    { latest: stable(1, lost), error: "latest attempt is still 1" },
    { latest: running(2), error: "attempt 2 still hasn't completed" },
  ])("fails when no newer attempt completes: $error", ({ latest, error }) => {
    const { calls, gh } = fakeGh([
      stable(1, lost),
      ...Array.from({ length: MAX_WATCHES }, () => latest),
    ]);
    expect(() => runRetryLoop("1", gh, () => {})).toThrow(error);
    expect(calls.filter((call) => call === "wait")).toHaveLength(MAX_WATCHES);
  });
});
