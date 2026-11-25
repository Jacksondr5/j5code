// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a CI step run as a standalone Node script.
// Decides whether a failed release run lost only macOS jobs that GitHub's hosted arm64 pool never
// picked up (#1246), and if so re-runs its failed jobs. Any other failure, or the attempt cap, stops it.
//
//   node scripts/j5/macos-capacity-retry.ts <run-id> [--attempt <n>] [--rerun]
//
// Without --rerun it only prints the decision. --attempt reads an earlier attempt and can't re-run.
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

interface ApiJob {
  readonly id: number;
  readonly name: string;
  readonly conclusion: string | null;
  readonly labels: ReadonlyArray<string>;
}

const ghJson = <T>(path: string): T =>
  JSON.parse(NodeChildProcess.execFileSync("gh", ["api", path], { encoding: "utf8" })) as T;

function readAttempt(runId: string, attempt: number | undefined): RunAttempt {
  const run = ghJson<{ conclusion: string | null; run_attempt: number }>(
    `repos/{owner}/{repo}/actions/runs/${runId}`,
  );
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

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runId = args[0];
  const attemptIndex = args.indexOf("--attempt");
  const attempt = attemptIndex === -1 ? undefined : Number(args[attemptIndex + 1]);
  const rerun = args.includes("--rerun");
  if (!runId || !/^\d+$/.test(runId) || (attempt !== undefined && !Number.isInteger(attempt))) {
    console.error("Usage: macos-capacity-retry.ts <run-id> [--attempt <n>] [--rerun]");
    process.exit(2);
  }
  if (rerun && attempt !== undefined) {
    console.error("--rerun acts on the latest attempt only; drop --attempt.");
    process.exit(2);
  }
  const decision = decideCapacityRetry(readAttempt(runId, attempt));
  console.log(
    `Run ${runId}: ${decision.rerun ? "re-run" : "no re-run"}, because ${decision.reason}.`,
  );
  if (decision.rerun && rerun) {
    NodeChildProcess.execFileSync("gh", ["run", "rerun", runId, "--failed"], { stdio: "inherit" });
  }
}
