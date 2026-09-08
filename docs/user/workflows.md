# Development workflows

Workflows needing approval appear in the Inbox as distinct workflow items and keep a
text **Needs approval** status until the gate is resolved. The sidebar prioritizes
approvals, blocked and failed work; **All workflows** opens complete paginated history
across Squadrons. Individual agent conversations are available under workflow
activity and include a durable link back to their parent workflow.

Open **Workflows**, choose **New workflow**, then select an eligible Squadron, enter
a development request and base ref, and choose **Start workflow**. A Squadron must
contain exactly one project; ineligible Squadrons are explained in the dialog. The base ref is
resolved once. Each run owns a separate branch and worktree under the server home.

Scout collects evidence, Navigator proposes the plan and executable checks, and
Advocate and Skeptic review it. **Approve plan** authorizes the displayed plan
version and checks. Builder implements it; the server executes those exact checks,
then Critic and Sentry review the validated candidate. Failed checks and blocking
reviews require repairs. There are at most two plan revisions and two implementation
repair rounds. Exhaustion blocks the run.

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
