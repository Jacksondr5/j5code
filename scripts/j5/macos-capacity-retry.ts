// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a CI step run as a standalone Node script.
// Decides whether a failed release run lost only macOS jobs that GitHub's hosted arm64 pool never
// picked up (#1246), and if so re-runs its failed jobs, waits for that attempt, and decides again.
// Any other failure, or the attempt cap, stops it.
//
//   node scripts/j5/macos-capacity-retry.ts <run-id> [--attempt <n>] [--rerun [--event-attempt <n>]]
//
// Without --rerun it only prints the decision; --attempt reads an earlier attempt. --event-attempt is
// the attempt that triggered the workflow: if it is no longer the latest, completed one, it does nothing.
import * as NodeChildProcess from "node:child_process";

export const MAX_ATTEMPTS = 5;
const CAPACITY_ANNOTATION = "The job was not acquired by Runner of type hosted";
const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export interface RunJob {
  readonly name: string;
  readonly conclusion: string | null;
  readonly labels: ReadonlyArray<string>;
  /** Messages of the job's failure-level annotations. */
  readonly failures: ReadonlyArray<string>;
}

export interface RunAttempt {
  readonly conclusion: string | null;
  readonly attempt: number;
  readonly jobs: ReadonlyArray<RunJob>;
}

export interface RetryDecision {
  readonly rerun: boolean;
  readonly reason: string;
}

const isCapacityCancellation = (job: RunJob) =>
  job.conclusion === "cancelled" &&
  job.labels.some((label) => /macos/i.test(label)) &&
  job.failures.length > 0 &&
  job.failures.every((message) => message.includes(CAPACITY_ANNOTATION));

const describe = (job: RunJob) =>
  `${job.name} (${[job.conclusion ?? "no conclusion", ...job.failures].join(": ")})`;

export function decideCapacityRetry(run: RunAttempt): RetryDecision {
  if (run.conclusion !== "failure") {
    return {
      rerun: false,
      reason: `the run's conclusion is ${run.conclusion ?? "none"}, not failure`,
    };
  }
  const notPassing = run.jobs.filter((job) => !PASSING_CONCLUSIONS.has(job.conclusion ?? ""));
  const capacity = notPassing.filter(isCapacityCancellation);
  const own = notPassing.filter((job) => !isCapacityCancellation(job));
  if (own.length > 0) {
    return { rerun: false, reason: `a job failed on its own: ${own.map(describe).join("; ")}` };
  }
  if (capacity.length === 0) {
    return { rerun: false, reason: "no job was cancelled for lack of a macOS runner" };
  }
  const lost = capacity.map((job) => job.name).join("; ");
  if (run.attempt >= MAX_ATTEMPTS) {
    return {
      rerun: false,
      reason: `attempt ${run.attempt} reached the cap of ${MAX_ATTEMPTS}; not picked up: ${lost}`,
    };
  }
  return {
    rerun: true,
    reason: `attempt ${run.attempt} lost only macOS jobs to runner capacity: ${lost}`,
  };
}

export interface RetryLoopGh {
  /** The run's latest attempt, once it has completed. */
  readonly readLatest: () => RunAttempt;
  readonly rerunFailed: () => void;
  /** Blocks until the run's latest attempt completes. */
  readonly waitForRun: () => void;
}

/** Re-runs and waits in one job, so the loop never depends on a re-run firing `workflow_run` again. */
export function runRetryLoop(
  runId: string,
  gh: RetryLoopGh,
  log: (line: string) => void,
): RetryDecision {
  let run = gh.readLatest();
  for (;;) {
    const decision = decideCapacityRetry(run);
    log(`Run ${runId}: ${decision.rerun ? "re-run" : "no re-run"}, because ${decision.reason}.`);
    if (!decision.rerun) return decision;
    gh.rerunFailed();
    log(`Run ${runId}: waiting for attempt ${run.attempt + 1} to complete.`);
    gh.waitForRun();
    const next = gh.readLatest();
    if (next.attempt <= run.attempt) {
      throw new Error(
        `Run ${runId}: re-ran attempt ${run.attempt}, but the latest attempt is still ${next.attempt}.`,
      );
    }
    run = next;
  }
}

interface ApiJob {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly labels: ReadonlyArray<string>;
}

interface ApiRun {
  readonly status: string;
  readonly conclusion: string | null;
  readonly run_attempt: number;
}

const ghJson = <T>(path: string): T =>
  JSON.parse(NodeChildProcess.execFileSync("gh", ["api", path], { encoding: "utf8" })) as T;

const readRun = (runId: string) => ghJson<ApiRun>(`repos/{owner}/{repo}/actions/runs/${runId}`);

function readAttempt(runId: string, attempt: number | undefined): RunAttempt {
  const run = readRun(runId);
  const n = attempt ?? run.run_attempt;
  // An earlier attempt's own conclusion isn't exposed; it failed, or there'd be a later one.
  const conclusion = n === run.run_attempt ? run.conclusion : "failure";
  const { jobs } = ghJson<{ jobs: ReadonlyArray<ApiJob> }>(
    `repos/{owner}/{repo}/actions/runs/${runId}/attempts/${n}/jobs?per_page=100`,
  );
  return {
    conclusion,
    attempt: n,
    jobs: jobs.map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      labels: job.labels,
      failures: PASSING_CONCLUSIONS.has(job.conclusion ?? "")
        ? []
        : ghJson<ReadonlyArray<{ annotation_level: string; message: string }>>(
            `repos/{owner}/{repo}/check-runs/${job.id}/annotations`,
          )
            .filter((annotation) => annotation.annotation_level === "failure")
            .map((annotation) => annotation.message),
    })),
  };
}

const option = (args: ReadonlyArray<string>, name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : Number(args[index + 1]);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runId = args[0];
  const attempt = option(args, "--attempt");
  const eventAttempt = option(args, "--event-attempt");
  const rerun = args.includes("--rerun");
  if (
    !runId ||
    !/^\d+$/.test(runId) ||
    [attempt, eventAttempt].some((n) => n !== undefined && !Number.isInteger(n))
  ) {
    console.error(
      "Usage: macos-capacity-retry.ts <run-id> [--attempt <n>] [--rerun [--event-attempt <n>]]",
    );
    process.exit(2);
  }
  if (rerun && attempt !== undefined) {
    console.error("--rerun acts on the latest attempt only; drop --attempt.");
    process.exit(2);
  }
  if (!rerun) {
    const decision = decideCapacityRetry(readAttempt(runId, attempt));
    console.log(
      `Run ${runId}: ${decision.rerun ? "re-run" : "no re-run"}, because ${decision.reason}.`,
    );
    process.exit(0);
  }
  if (eventAttempt !== undefined) {
    // A re-run attempt's own `workflow_run`, if GitHub sends one, finds the loop already handled it.
    const run = readRun(runId);
    if (run.status !== "completed" || run.run_attempt !== eventAttempt) {
      console.log(
        `Run ${runId}: nothing to do; attempt ${eventAttempt} triggered this, and the latest is attempt ${run.run_attempt} (${run.status}).`,
      );
      process.exit(0);
    }
  }
  runRetryLoop(
    runId,
    {
      readLatest: () => readAttempt(runId, undefined),
      rerunFailed: () =>
        NodeChildProcess.execFileSync("gh", ["run", "rerun", runId, "--failed"], {
          stdio: "inherit",
        }),
      // Without --exit-status: a failed attempt is expected here, and the decision reads it.
      waitForRun: () =>
        NodeChildProcess.execFileSync(
          "gh",
          ["run", "watch", runId, "--compact", "--interval", "60"],
          { stdio: ["ignore", "ignore", "inherit"] },
        ),
    },
    (line) => console.log(line),
  );
}
