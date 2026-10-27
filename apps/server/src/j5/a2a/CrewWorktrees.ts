import {
  OrchestrationV2ProviderSessionJson,
  type OrchestrationV2StoredEvent,
  type ThreadId,
} from "@t3tools/contracts";
import {
  CrewSeatWorkspace,
  type CrewArchiveWorktree,
  type CrewArchiveWorktreeEstimate,
  type CrewWorktreeReason,
} from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitManager from "../../git/GitManager.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { storageCleanupPullRequestMerged } from "../../storageCleanup.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import { readEventStoreHighWater } from "./eventStoreHighWater.ts";

const decodeSeatWorkspace = Schema.decodeUnknownOption(Schema.fromJsonString(CrewSeatWorkspace));
const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

/** A seat of a Crew being archived, with the thread whose worktree it may own. */
export interface CrewWorktreeSeat {
  readonly seatName: string;
  readonly threadId: ThreadId;
}

type KeepReason = Exclude<CrewWorktreeReason, "failed">;

interface RecordedWorktree {
  readonly threadId: ThreadId;
  readonly path: string;
  /** The branch as the worktree was created; the thread's current branch is read when it counts. */
  readonly createdBranch: string | null;
}

/** What a check found at one worktree: gone, or a reason to keep it, or free to remove. */
type Verdict =
  | { readonly kind: "gone" }
  | { readonly kind: "keep"; readonly reason: KeepReason }
  | { readonly kind: "remove"; readonly headSha: string };

export interface CrewWorktreesShape {
  /**
   * Records the worktree upstream's ThreadLaunch creates for a Crew seat on a new worktree, when
   * the event is that seat's first `thread.metadata.update` binding a path. Returns whether a row
   * was written. Worktrees bound any other way, and every worktree from before the record
   * existed, have no row and are never removed.
   */
  readonly handleStoredEvent: (event: OrchestrationV2StoredEvent) => Effect.Effect<boolean>;
  /**
   * The cleanup after a Crew's archive commits: each recorded worktree of an archived seat is
   * removed when it is clean, merged, unshared and unused, and kept with its reason otherwise.
   * Never fails: a problem checking or removing one worktree is that worktree's outcome, and a
   * problem reading the records leaves the whole pass empty and logged.
   */
  readonly cleanup: (input: {
    readonly seats: ReadonlyArray<CrewWorktreeSeat>;
  }) => Effect.Effect<ReadonlyArray<CrewArchiveWorktree>>;
  /**
   * What cleanup would do to these Crews' worktrees if it ran now, for the pre-archive warning.
   * Changes nothing and fetches nothing, so it is only an estimate. Never fails.
   */
  readonly estimate: (input: {
    readonly crews: ReadonlyArray<{
      readonly crewInstanceId: string;
      readonly seats: ReadonlyArray<CrewWorktreeSeat>;
    }>;
  }) => Effect.Effect<ReadonlyArray<CrewArchiveWorktreeEstimate>>;
}

export class CrewWorktrees extends Context.Service<CrewWorktrees, CrewWorktreesShape>()(
  "t3/j5/a2a/CrewWorktrees",
) {}

const makeLayer = (daemon: boolean) =>
  Layer.effect(
    CrewWorktrees,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threads = yield* ThreadManagementService;
      const projects = yield* ProjectService;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const gitManager = yield* GitManager.GitManager;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const handleStoredEvent: CrewWorktreesShape["handleStoredEvent"] = (stored) =>
        Effect.gen(function* () {
          const event = stored.event;
          if (event.type !== "thread.metadata-updated" || event.payload.worktreePath === null)
            return false;
          const [context] = yield* sql<{ readonly workspace: string }>`
            SELECT workspace FROM j5_crew_seat_context WHERE thread_id = ${event.threadId}
          `;
          if (context === undefined) return false;
          const workspace = decodeSeatWorkspace(context.workspace);
          if (Option.isNone(workspace) || workspace.value.type !== "worktree") return false;
          // The first path wins: a later update (a branch rename, a person re-pointing the
          // thread) must not move the record off the checkout J5 created.
          const inserted = yield* sql<{ readonly thread_id: string }>`
            INSERT INTO j5_crew_worktree (thread_id, project_id, path, branch, created_at)
            VALUES (
              ${event.threadId}, ${event.payload.projectId}, ${event.payload.worktreePath},
              ${event.payload.branch}, ${DateTime.formatIso(event.occurredAt)}
            )
            ON CONFLICT (thread_id) DO NOTHING
            RETURNING thread_id
          `;
          return inserted.length > 0;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Crew worktree record skipped", { cause }).pipe(Effect.as(false)),
          ),
        );

      const readRecord = (threadId: ThreadId) =>
        sql<{
          readonly path: string;
          readonly branch: string | null;
        }>`SELECT path, branch FROM j5_crew_worktree WHERE thread_id = ${threadId}`.pipe(
          Effect.map((rows): RecordedWorktree | null =>
            rows[0] === undefined
              ? null
              : { threadId, path: rows[0].path, createdBranch: rows[0].branch },
          ),
        );

      /** Another unarchived thread bound to this path; the Crew's own seats are being archived. */
      const sharedWithOthers = (worktreePath: string, own: ReadonlySet<ThreadId>) =>
        projections
          .getThreadWorktreePaths()
          .pipe(
            Effect.map((bound) =>
              bound.some(
                (entry) =>
                  path.resolve(entry.worktreePath) === worktreePath && !own.has(entry.threadId),
              ),
            ),
          );

      /** A provider session still open in the worktree or a folder of it. */
      const sessionOpenIn = Effect.fnUntraced(function* (worktreePath: string) {
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT payload_json FROM orchestration_v2_projection_provider_sessions
          WHERE status != 'stopped'
        `;
        for (const row of rows) {
          const session = yield* decodeSession(row.payload_json);
          const cwd = path.resolve(session.cwd);
          const inside = cwd === worktreePath || cwd.startsWith(`${worktreePath}${path.sep}`);
          // A stored session can stay ready after its runtime was released; only a live one holds it.
          if (inside && (yield* providerSessions.isLive(session.id))) return true;
        }
        return false;
      });

      /** Tracked changes, and untracked files git does not ignore. Ignored files never block. */
      const hasBlockingChanges = Effect.fnUntraced(function* (worktreePath: string) {
        const status = yield* git.execute({
          operation: "CrewWorktrees.localChanges",
          cwd: worktreePath,
          args: [
            "status",
            "--porcelain=v1",
            "-z",
            "--ignore-submodules=none",
            "--untracked-files=all",
          ],
          maxOutputBytes: 64 * 1024,
        });
        return status.stdoutTruncated || status.stdout.split("\0").some((record) => record !== "");
      });

      /**
       * Merged into the project's default branch as last fetched, or named by a merged pull
       * request as exactly this commit, which is how a squash or rebase merge shows.
       */
      const mergeKeepReason = Effect.fnUntraced(function* (input: {
        readonly worktreePath: string;
        readonly repositoryRoot: string;
        readonly branch: string | null;
        readonly refresh: boolean;
        readonly fetched: Set<string>;
      }) {
        const remote = yield* git.resolvePrimaryRemoteName(input.repositoryRoot);
        const defaultBranch = yield* git.resolveDefaultBranchName(input.repositoryRoot, remote);
        if (defaultBranch === null) return "unverified" as const;
        const fetchKey = `${input.repositoryRoot}\0${remote}\0${defaultBranch}`;
        if (input.refresh && !input.fetched.has(fetchKey)) {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.repositoryRoot,
            remoteName: remote,
            remoteBranch: defaultBranch,
          });
          input.fetched.add(fetchKey);
        }
        const head = yield* git.resolveCommit({ cwd: input.worktreePath, revision: "HEAD" });
        const base = yield* git.resolveCommit({
          cwd: input.worktreePath,
          revision: `refs/remotes/${remote}/${defaultBranch}`,
        });
        const ancestor = yield* git.execute({
          operation: "CrewWorktrees.integrated",
          cwd: input.worktreePath,
          args: ["merge-base", "--is-ancestor", head.commitSha, base.commitSha],
          allowNonZeroExit: true,
        });
        if (ancestor.exitCode === 0) return null;
        if (ancestor.exitCode !== 1) return "unverified" as const;
        if (input.branch === null) return "unmerged_commits" as const;
        const pullRequest = yield* gitManager.branchPullRequest(
          { cwd: input.worktreePath, branch: input.branch },
          { refresh: input.refresh },
        );
        return storageCleanupPullRequestMerged(pullRequest, {
          branch: input.branch,
          defaultBranch,
          headSha: head.commitSha,
          integrated: false,
        })
          ? null
          : ("unmerged_commits" as const);
      });

      interface CheckContext {
        readonly own: ReadonlySet<ThreadId>;
        readonly refresh: boolean;
        readonly fetched: Set<string>;
        /** False for the look right before a removal: the first look already decided it, and the commit is compared instead. */
        readonly checkMerged: boolean;
      }

      const threadFacts = (threadId: ThreadId) =>
        threads.getThreadRecords(threadId, []).pipe(
          Effect.map(({ thread }) => thread),
          Effect.result,
        );

      /** Everything that can keep a worktree, cheapest first. Throws nothing: a failed check keeps it. */
      const check = Effect.fnUntraced(function* (
        record: RecordedWorktree,
        branch: string | null,
        repositoryRoot: string,
        context: CheckContext,
      ) {
        const worktreePath = path.resolve(record.path);
        if (!(yield* fs.exists(worktreePath))) return { kind: "gone" } satisfies Verdict;
        // A linked worktree's `.git` is a file; a directory is a whole checkout, never ours to remove.
        if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
          return { kind: "keep", reason: "unverified" } satisfies Verdict;
        if (yield* sharedWithOthers(worktreePath, context.own))
          return { kind: "keep", reason: "shared" } satisfies Verdict;
        if (yield* sessionOpenIn(worktreePath))
          return { kind: "keep", reason: "in_use" } satisfies Verdict;
        if (yield* hasBlockingChanges(worktreePath))
          return { kind: "keep", reason: "uncommitted_changes" } satisfies Verdict;
        const unmerged = context.checkMerged
          ? yield* mergeKeepReason({
              worktreePath,
              repositoryRoot,
              branch,
              refresh: context.refresh,
              fetched: context.fetched,
            })
          : null;
        if (unmerged !== null) return { kind: "keep", reason: unmerged } satisfies Verdict;
        const head = yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" });
        return { kind: "remove", headSha: head.commitSha } satisfies Verdict;
      });

      const verdictOf = (
        record: RecordedWorktree,
        branch: string | null,
        repositoryRoot: string,
        context: CheckContext,
      ) =>
        check(record, branch, repositoryRoot, context).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Crew worktree check could not finish", {
              threadId: record.threadId,
              cause,
            }).pipe(Effect.as({ kind: "keep", reason: "unverified" } satisfies Verdict)),
          ),
        );

      const repositoryRootOf = (projectId: Parameters<ProjectService["Service"]["getById"]>[0]) =>
        projects
          .getById(projectId)
          .pipe(
            Effect.map((project) => Option.getOrNull(Option.map(project, (p) => p.workspaceRoot))),
          );

      const remove = Effect.fnUntraced(function* (
        record: RecordedWorktree,
        branch: string | null,
        repositoryRoot: string,
        context: CheckContext,
      ) {
        const worktreePath = path.resolve(record.path);
        // Under the workspace lease storage cleanup and a thread's own repair use, and read
        // again right before the removal: a session, a second thread, an edit or a commit that
        // arrived since the first look cancels it.
        return yield* withWorkspaceLease(
          worktreePath,
          Effect.gen(function* () {
            const first = yield* verdictOf(record, branch, repositoryRoot, context);
            if (first.kind !== "remove") return first;
            const again = yield* verdictOf(record, branch, repositoryRoot, {
              ...context,
              refresh: false,
              checkMerged: false,
            });
            if (again.kind !== "remove" || again.headSha !== first.headSha)
              return again.kind === "remove"
                ? ({ kind: "keep", reason: "unverified" } satisfies Verdict)
                : again;
            yield* git.removeWorktree({ cwd: repositoryRoot, path: worktreePath });
            yield* gitManager.invalidateStatus(repositoryRoot);
            return first;
          }),
        );
      });

      const cleanup: CrewWorktreesShape["cleanup"] = ({ seats }) =>
        Effect.gen(function* () {
          const own = new Set(seats.map((seat) => seat.threadId));
          const context: CheckContext = {
            own,
            refresh: true,
            fetched: new Set(),
            checkMerged: true,
          };
          const results: Array<CrewArchiveWorktree> = [];
          for (const seat of seats) {
            const record = yield* readRecord(seat.threadId);
            if (record === null) continue;
            const thread = yield* threadFacts(seat.threadId);
            // Only a thread that is archived has let go of its worktree.
            if (thread._tag === "Failure" || thread.success.archivedAt === null) continue;
            // The branch is read now: the seat may have renamed it since the worktree was created.
            const branch = thread.success.branch ?? record.createdBranch;
            const outcome = (
              result: Pick<CrewArchiveWorktree, "outcome" | "reason">,
            ): CrewArchiveWorktree => ({ path: record.path, branch, ...result });
            const repositoryRoot = yield* repositoryRootOf(thread.success.projectId).pipe(
              Effect.orElseSucceed(() => null),
            );
            if (repositoryRoot === null) {
              results.push(outcome({ outcome: "kept", reason: "unverified" }));
              continue;
            }
            const done = yield* remove(record, branch, repositoryRoot, context).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 Crew worktree removal failed", {
                  threadId: seat.threadId,
                  cause,
                }).pipe(Effect.as("failed" as const)),
              ),
            );
            if (done === "failed") results.push(outcome({ outcome: "failed", reason: "failed" }));
            else if (done.kind === "keep")
              results.push(outcome({ outcome: "kept", reason: done.reason }));
            else if (done.kind === "remove") {
              yield* Effect.logInfo("J5 Crew worktree removed after archive", {
                threadId: seat.threadId,
              });
              results.push(outcome({ outcome: "removed", reason: null }));
            }
          }
          return results;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Crew worktree cleanup skipped", { cause }).pipe(
              Effect.as([] as ReadonlyArray<CrewArchiveWorktree>),
            ),
          ),
        );

      const estimate: CrewWorktreesShape["estimate"] = ({ crews }) =>
        Effect.gen(function* () {
          const results: Array<CrewArchiveWorktreeEstimate> = [];
          for (const crew of crews) {
            const context: CheckContext = {
              own: new Set(crew.seats.map((seat) => seat.threadId)),
              refresh: false,
              fetched: new Set(),
              checkMerged: true,
            };
            for (const seat of crew.seats) {
              const record = yield* readRecord(seat.threadId);
              if (record === null) continue;
              const thread = yield* threadFacts(seat.threadId);
              if (thread._tag === "Failure") continue;
              const branch = thread.success.branch ?? record.createdBranch;
              const repositoryRoot = yield* repositoryRootOf(thread.success.projectId).pipe(
                Effect.orElseSucceed(() => null),
              );
              const verdict: Verdict =
                repositoryRoot === null
                  ? { kind: "keep", reason: "unverified" }
                  : yield* verdictOf(record, branch, repositoryRoot, context);
              if (verdict.kind === "gone") continue;
              results.push({
                crewInstanceId: crew.crewInstanceId,
                seat: seat.seatName,
                path: record.path,
                branch,
                verdict: verdict.kind === "remove" ? "remove" : "keep",
                reason: verdict.kind === "keep" ? verdict.reason : null,
              });
            }
          }
          return results;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("J5 Crew worktree estimate skipped", { cause }).pipe(
              Effect.as([] as ReadonlyArray<CrewArchiveWorktreeEstimate>),
            ),
          ),
        );

      if (daemon) {
        // From the event store's current high-water mark: a launch that finished while the server
        // was down is simply not recorded, and a worktree with no row is never removed.
        const runDaemon = Effect.gen(function* () {
          let afterSequence = yield* readEventStoreHighWater("J5 Crew worktree recorder");
          return yield* Effect.forever(
            Stream.suspend(() => threads.streamStoredEventsFrom({ afterSequence })).pipe(
              Stream.runForEach((event) =>
                handleStoredEvent(event).pipe(
                  Effect.tap(() => Effect.sync(() => (afterSequence = event.sequence))),
                ),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("J5 Crew worktree recorder stream failed; resuming", {
                  cause,
                }).pipe(Effect.andThen(Effect.sleep(Duration.seconds(1)))),
              ),
            ),
          );
        });
        yield* Effect.forkScoped(runDaemon);
      }

      return CrewWorktrees.of({ handleStoredEvent, cleanup, estimate });
    }),
  );

export const manualLayer = makeLayer(false);
export const layer = makeLayer(true);
