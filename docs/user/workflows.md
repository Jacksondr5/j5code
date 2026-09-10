# Development workflows

Workflows needing approval appear in the Inbox as distinct workflow items and keep a
text **Needs approval** status until the gate is resolved. Open Workflows in the panel
beside a thread to review runs and resolve approvals without leaving the conversation.
All workflows opens the complete paginated history across Squadrons. Individual agent conversations are available under workflow
activity and include a durable link back to their parent workflow.

When an approved verification command fails, the workflow diagnoses whether the code,
environment, or command needs repair. A command correction requires a separate **Approve
corrected checks** decision before it can run. The original plan remains unchanged. A run can
approve one correction, with at most two proposal versions, and the replacement must preserve
the number, order, and intent of the approved checks.

Open **Workflows**, choose **New workflow**, then select an eligible Squadron, enter
a development request and base ref, and choose **Start workflow**. A Squadron must
contain exactly one project; ineligible Squadrons are explained in the dialog. The base ref is
resolved once. Each run owns a separate branch and worktree under the server home.

Scout collects evidence, and Navigator proposes the plan and executable checks. Plans
record assumptions used to resolve unspecified product choices. Advocate and Skeptic
block a plan only when it contradicts the request or supplied evidence, is infeasible,
or lacks executable verification.

**Approve plan** authorizes the displayed plan version and checks. If reviewers still
reject the plan when no further plan-review cycle is available, the workflow reaches
**Approve plan** with both reviews attached. Approval permits implementation despite
reviewer dissent. Requesting further changes after the revision budget is exhausted
requires a new run.

Builder implements the approved plan; the server executes its exact checks, then Critic
and Sentry review the validated candidate. Failed checks and blocking implementation
reviews require repairs. There are at most two plan revisions and two implementation
repair rounds. Implementation-repair exhaustion continues to block the run.

At the publication gate, inspect the recorded per-file diff, reviews, repository,
branches, commit message, and draft PR title/body. Save edited publication text before
approval; unsaved edits disable **Approve and publish**. Saving creates a new technical
gate revision that must be reviewed explicitly. Approval binds that revision and exact candidate tree.
The server reconciles commit, push, and draft PR creation separately. It never
force-pushes or merges. GitHub publication requires an authenticated `gh` CLI and a
GitHub origin for the project; a local bare remote is sufficient for fixture tests.

Workflows continue without an open browser. Reloading the Workflows URL restores the selected
workflow. Approval submissions include the gate revision and artifact hash; stale
submissions are rejected. Changed candidate files invalidate dependent evidence.
Cancel stops successors and interrupts owned work; it preserves artifacts,
worktrees, and already completed publication.

Blocked workflows explain their failure category, technical cause, and permitted recovery.
When plan or code review reaches its deadline, **Restart plan review** or
**Restart code review** stops the old reviewers and starts both reviewers again with a
fresh 30-minute window. The restart uses the next existing review attempt and retains
earlier evidence and conversation links. If reviewer cleanup fails, retry the restart
or cancel the workflow.
**Reconcile action** is available only when reconciliation is supported and retains the
same action identity, deadline, and budgets. An interrupted verification command with an unknown
result requires inspection; there is no bypass button. A missing or changed
workflow definition requires restoring its exact version. Agent output has two
correction opportunities and an attempt deadline of 30 minutes that survives restart.
Cancellation always asks for confirmation and preserves recorded evidence and any
publication that already completed. Completed workflows show their commit, push result,
and draft pull request link.

For local development, use the dedicated home and printed pairing URL:

```sh
vp run dev --home-dir /Users/bastian.huppertz/Projects/j5code-dev-state
```

After reviewing changes to workflow source, regenerate its build manifest with
`node scripts/j5-workflow-manifest.mjs`. The server build checks this manifest so
source and bundled Electron execution use the same definition identity.

Before starting, configure the environment’s YAML persona library with scout, navigator, advocate, skeptic, builder, critic, and sentry. Builder must permit workspace-write, critic must permit critic-review, and the other roles must permit read-only. A missing, disabled, invalid, or unavailable role prevents the workflow from starting.

A workflow saves all seven definitions and model choices at creation. Library changes affect future workflows; later phases and retries keep the saved assignments. If a saved provider becomes unavailable, restore that provider and model before retrying. Older tasks without saved definitions remain readable but require a fresh task to continue.
