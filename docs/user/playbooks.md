# Development playbooks

Playbooks needing approval appear in the Inbox as distinct playbook items and keep a
text **Needs approval** status until the gate is resolved. Open Playbooks in the panel
beside a thread to review runs and resolve approvals without leaving the conversation.
All playbooks opens the complete paginated history across Squadrons. Individual agent conversations are available under playbook
activity and include a durable link back to their parent playbook.

When an approved verification command fails, the playbook diagnoses whether the code,
environment, or command needs repair. A command correction requires a separate **Approve
corrected checks** decision before it can run. The original plan remains unchanged. A run can
approve one correction, with at most two proposal versions, and the replacement must preserve
the number, order, and intent of the approved checks.

The Playbooks page opens as a Board so you can scan phase progress, active agents, and approvals
across runs. Open a run and choose Timeline to trace recorded phase changes, agent or code work,
and human decisions.

Open **Playbooks**, choose **New playbook**, select a playbook definition and eligible Squadron,
enter a request and base ref, and choose **Start playbook**. A Squadron must
contain exactly one project; ineligible Squadrons are explained in the dialog. The base ref is
resolved once. Each run owns a separate branch and worktree under the server home.

## YAML playbook definitions

Settings → Playbooks imports `.yaml` and `.yml` definitions into the selected server environment.
Imported definitions override configured and shipped definitions with the same id. Disable an
import to prevent future starts. Remove an import or a definition created through the guided flow
to reveal any lower-priority definition with the same id. Removal keeps existing runs, history,
and their immutable snapshots. Shipped definitions and definitions loaded from folders in
`playbooks.json` are read-only. Invalid files remain listed with their diagnostic and do not hide
valid playbooks.

Definitions use `schema: t3-playbook/v1`, an ordered `phases` list, and explicit transitions.
An agent task sets exactly one of `agent` or `persona`. `agent` refers to a named entry under
`agents` and reuses that conversation on every later phase; `persona` starts a fresh conversation
for that task. The same named agent cannot run twice in one phase. Built-in outputs are `report`
and `review`; review verdicts must agree with blocking findings and identify selected evidence.
Phase visits default to one, so add `visitLimit` to every phase that a transition can revisit.

### Publishing from custom playbooks

Use one sequence: metadata preparation → publication approval → commit → push → draft PR.
Each code phase has one task with `operation: metadata`, `commit`, `push`, or `draft`.
Preparation selects one developer report phase through `evidence`; that phase must have one
report task and run before preparation. Include preparation in the gate's evidence. Only
`approve` may enter commit. Draft creation may end at `$complete` or continue to review feedback.
Phase names are yours to choose.

Preparation captures the candidate diff and publication text. Edit the commit message and PR
text at the approval gate, save, then approve the new gate version. Changed code needs fresh
preparation and approval. Route `request_changes` and `changed` back through development or
preparation, and give revisited phases enough visits. Custom playbooks use developer reports
for verification evidence; `workspace`, `validation`, and `repair_capacity` operations are
reserved for built-in implementations.

For post-publication review, add a code task with `operation: feedback` after the draft phase,
then pass its evidence to a reviewer such as Herald. Collection reads the exact published PR
head, conversation comments, reviews, and inline threads without granting the persona network
or publication permissions. Large inline threads report collection limits; unavailable GitHub
access or a changed PR head stops the step. A human finish/refresh gate can send `request_changes`
back to feedback collection while waiting for reviews.

Rework must pass through preparation and fresh publication approval again. Each approved update
appends a commit and updates the same open draft PR; unexpected local or remote commits stop
publication. Give each repeated phase a suitable `visitLimit`. No polling, force-push, or merge
is performed.

### Validation

Generic YAML transitions use `approve`/`request_changes` for gates, `completed` (and `revise`
for review aggregation) for agent phases, and `pass` for code phases. `changed` is reserved for invalidation. Evidence references must name a phase
(or `__workspace`) and approval references must name a gate; import diagnostics identify the
source file and field.

```yaml
schema: t3-playbook/v1
id: focused-research
version: 1
name: Focused research
description: Research, review, and approve a report.
initial: research
agents:
  researcher: { persona: scout, authority: read-only }
phases:
  - id: research
    kind: agent
    visitLimit: 2
    tasks:
      - id: investigate
        agent: researcher
        instructions: Research the request and state unknowns.
        output: report
    transitions: { completed: review }
  - id: review
    kind: agent
    evidence: [research]
    tasks:
      - id: check
        persona: critic
        authority: critic-review
        instructions: Review the report against its evidence.
        output: review
    outcome: review
    transitions: { completed: approval, revise: research }
  - id: approval
    kind: gate
    evidence: [research, review]
    transitions: { approve: $complete, request_changes: research }
```

Configured server folders are listed in `<stateDir>/playbooks.json`; relative paths
resolve from the state directory. Without that file, the server reads YAML files recursively from
`<stateDir>/playbooks`. Back up `imported-playbooks.json` and
`playbook-snapshots`. The latter contains immutable definitions used to resume active and
historical runs after their library entry changes or is removed. Missing or unsupported saved
definitions block execution rather than substituting current behavior.

Scout collects evidence, and Navigator proposes the plan and executable checks. Plans
record assumptions used to resolve unspecified product choices. Advocate and Skeptic
block a plan only when it contradicts the request or supplied evidence, is infeasible,
or lacks executable verification.

**Approve plan** authorizes the displayed plan version and checks. If reviewers still
reject the plan when no further plan-review cycle is available, the playbook reaches
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

Playbooks continue without an open browser. Reloading the Playbooks URL restores the selected
playbook. Approval submissions include the gate revision and artifact hash; stale
submissions are rejected. Changed candidate files invalidate dependent evidence.
Cancel stops successors and interrupts owned work; it preserves artifacts,
worktrees, and already completed publication.

Blocked playbooks explain their failure category, technical cause, and permitted recovery.
If the server quits, restarts, or crashes during a step, the run shows **Interrupted** instead of
starting work automatically. Choose **Resume playbook** to keep completed steps, evidence,
approvals, and the existing worktree. The playbook accepts any result that completed before
shutdown; otherwise it continues the saved agent conversation when available or starts only the
unfinished task again. Resumed work receives a fresh 30-minute deadline.
When plan or code review reaches its deadline, **Restart plan review** or
**Restart code review** stops the old reviewers and starts both reviewers again with a
fresh 30-minute window. The restart uses the next existing review attempt and retains
earlier evidence and conversation links. If reviewer cleanup fails, retry the restart
or cancel the playbook.
**Reconcile action** is available only when reconciliation is supported and retains the
same action identity, deadline, and budgets. An interrupted verification command with an unknown
result requires inspection; there is no bypass button. A missing or changed
playbook definition requires restoring its exact version. Agent output has two
correction opportunities, and output corrections retain the original 30-minute deadline.
Cancellation always asks for confirmation and preserves recorded evidence and any
publication that already completed. Completed playbooks show their commit, push result,
and draft pull request link.

For local development, use the dedicated home and printed pairing URL:

```sh
vp run dev --home-dir /Users/bastian.huppertz/Projects/j5code-dev-state
```

After reviewing changes to playbook runtime source, regenerate its build manifest with
`node scripts/j5-playbook-manifest.mjs`. The server build checks this manifest so
source and bundled Electron execution use the reviewed runtime. Development’s definition identity
and runtime marker use that build hash, so a runtime change cannot silently resume against different code.

Before starting, configure the environment’s YAML persona library with scout, navigator, advocate, skeptic, builder, critic, and sentry. Builder must permit workspace-write, critic must permit critic-review, and the other roles must permit read-only. A missing, disabled, invalid, or unavailable role prevents the playbook from starting.

A playbook saves all seven definitions and model choices at creation. Library changes affect future playbooks; later phases and retries keep the saved assignments. If a saved provider becomes unavailable, restore that provider and model before retrying. Older tasks without saved definitions remain readable but require a fresh task to continue.
