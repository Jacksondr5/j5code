---
title: "Questions for the live PR-Group fleet (forward via Jackson)"
kind: spec
---

# Questions for the live fleet

<user_quoted_section>Canonical copy: Jacksondr5/pr-group @ ebe18cf, interviews/ directory — per-role questionnaires (now also toolsmith, triage, coordinator/leads), stats.sh, and answer instructions. Agents write answers to interviews/answers/&lt;questionnaire&gt;-&lt;agent-id-prefix&gt;.md and push to main; we read them from there. This artifact remains as the rationale record (the "what each block feeds" mapping below, extended: toolsmith → agent-proof tool design + missing-platform-API ranking; triage → machine-triggered work UX + escalation context; coordinator → org lifecycle, attention aggregation through middle managers, cost surface).</user_quoted_section>

The public repos were scrubbed of operational data; the running agents on Jackson's work laptop hold the experiential knowledge. Each block below is written to be **forwarded as-is** to the named agent. Answers should come back through Jackson; sanitized examples (fake PR numbers, generic component names) are fine everywhere — we want the _shape_ of the experience, never company specifics.

Priorities if time is short: the Spawner block and the SQL block are the highest-value; then the Sitter block.

## To a Spawner (the middle manager — pick the longest-tenured one)

<user_quoted_section>Jackson is designing a fleet-management platform informed by how this PR-Group program actually ran. You're the role with the most coordination experience. Answer from real operational history, with concrete (sanitized) examples. Six questions:
Filtering: You decide what reaches Jackson. Describe 2–3 real cases where you were genuinely unsure whether to escalate. What tipped the decision? What did you deliberately absorb that a naive design would have surfaced to him?Ambient vs asked: What do you currently have to ask your groups that you wish you could just see? Conversely, what group traffic reaches you that you never act on?Silence and recovery: When a group member went quiet, walk through your actual diagnosis-and-recovery sequence. Which recovery actions worked (re-send, direct nudge, asking the Sitter, telling Jackson, replacing the agent)? Which made things worse? Were there kinds of silence you couldn't distinguish that you needed to? (Known categories elsewhere: turn-ended-no-reply, process-exited, long-quiet, user-stopped, errored, waiting-on-a-human, cancelled — does that taxonomy cover what you saw?)Playbook drift: Where do the playbooks and reality diverge most? Which rules get broken or misremembered most often? When the playbooks were updated mid-flight, how did the notify-and-drill process actually go?Norms vs mechanisms: What do you enforce purely by convention/vigilance that you wish were mechanically enforced? What loop do you close by hand most often?One change: If you could change one thing about how you coordinate groups, what would it be?</user_quoted_section>

## To a Sitter (pick one that survived a full PR → backport → retire cycle)

<user_quoted_section>Jackson is designing a fleet-management platform based on this program. You're the communications hub of your group. From real experience, five questions:
Ask quality: Which of your asks did Jackson answer fastest, and which sat longest? Looking back, which asks would you not file again, and why? What makes a title/body answerable at a glance?The urgency taxonomy: Is blocking | soon | fyi the right set? Was there ever an ask that fit none of them, or where you downgraded/upgraded urgency strategically?Waiting behavior: While a blocking ask was open, what did your group actually do — fully stop, work around it, or drift? Did anything ever get built on a guess about the answer?Wake-up reliability: How reliable was the 10-minute GitHub-poll wake in practice? What events do you wish woke you immediately (a specific CI failure, a human review, a comment mentioning you…)? What woke you that shouldn't have?Outside traffic: What communication arrived from outside your group (other groups, other agents, humans on the PR), and how did you triage it? What outside message was hardest to handle?</user_quoted_section>

## To a Builder and a Reviewer (one each; same questions)

<user_quoted_section>Jackson is designing a fleet-management platform based on this program. From your seat, four questions:
Spawn gaps: What did your spawn brief not tell you that you had to discover or ask about? What should every future brief for your role include?Counterpart friction: Where does the Builder↔Reviewer alternation (the baton) actually break down? Describe a real deadlock, dropped baton, or duplicated effort and its cause.(Reviewer especially) Independence: Did talking to the Builder over A2A ever make you less independent as a reviewer? What kept your verdicts honest — and would you change how much contact the roles have?Rules under pressure: Which of the nine hard rules did you come closest to breaking, and in what situation? Which rule felt like it was compensating for a missing tool rather than a real principle?</user_quoted_section>

## SQL: the numbers the scrub removed (aggregates only)

Run on the laptop against the dashboard DB. Every query returns counts/durations only — no titles, bodies, logins, or repo content — so the output is safe to share.

```bash
sqlite3 ~/.pr-group-dashboard/dashboard.db <<'SQL'
.mode column
.headers on
SELECT 'asks by urgency x status' AS section;
SELECT urgency, status, COUNT(*) n FROM ask WHERE source='cli' GROUP BY urgency, status;

SELECT 'ask time-to-answer (hours)' AS section;
SELECT urgency,
       COUNT(*) answered,
       ROUND(AVG((julianday(answered_at)-julianday(created_at))*24),1) avg_h,
       ROUND(MIN((julianday(answered_at)-julianday(created_at))*24),1) min_h,
       ROUND(MAX((julianday(answered_at)-julianday(created_at))*24),1) max_h
FROM ask WHERE status='answered' AND answered_at IS NOT NULL AND source='cli'
GROUP BY urgency;

SELECT 'open ask age now (hours)' AS section;
SELECT urgency, COUNT(*) n,
       ROUND(MAX((julianday('now')-julianday(created_at))*24),1) oldest_h
FROM ask WHERE status='open' GROUP BY urgency;

SELECT 'findings by status x severity' AS section;
SELECT status, severity, COUNT(*) n FROM finding GROUP BY status, severity;

SELECT 'deferral evidence discipline' AS section;
SELECT CASE WHEN ask_id IS NOT NULL THEN 'ask-backed'
            WHEN ticket IS NOT NULL THEN 'ticket-only'
            ELSE 'no ruling' END evidence, COUNT(*) n
FROM finding WHERE status='deferred' GROUP BY 1;

SELECT 'groups by status + reopens' AS section;
SELECT status, COUNT(*) n, SUM(reopened_at IS NOT NULL) reopened FROM pr_group GROUP BY status;

SELECT 'group lifetime, done groups (days)' AS section;
SELECT COUNT(*) n,
       ROUND(AVG(julianday(updated_at)-julianday(first_seen_at)),1) avg_d,
       ROUND(MAX(julianday(updated_at)-julianday(first_seen_at)),1) max_d
FROM pr_group WHERE status='done';

SELECT 'current agent liveness' AS section;
SELECT liveness, COUNT(*) n, SUM(reply_expected) blocked_waiters FROM agent GROUP BY liveness;

SELECT 'poll health (last 500 runs)' AS section;
SELECT kind, COUNT(*) runs, SUM(errors IS NOT NULL) with_errors,
       ROUND(AVG(duration_ms)) avg_ms
FROM (SELECT * FROM poll_run ORDER BY id DESC LIMIT 500) GROUP BY kind;

SELECT 'decisions and PRs (volume)' AS section;
SELECT (SELECT COUNT(*) FROM decision) decisions,
       (SELECT COUNT(*) FROM pr) prs,
       (SELECT COUNT(*) FROM pr WHERE role_in_group='backport') backports,
       (SELECT COUNT(*) FROM review_thread) review_threads;
SQL
```

## What each block feeds

| Source                  | Feeds                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| Spawner Q1–2            | Attention-queue design; what the dashboard must make ambient; escalation UX for middle managers   |
| Spawner Q3              | Validation (or extension) of the typed-silence taxonomy and recovery affordances                  |
| Spawner Q4–5, member Q4 | Live role config (item 3); which norms become platform mechanisms                                 |
| Sitter Q1–3             | Human-inbox UX: intent summaries, urgency taxonomy, what "blocked on human" really does to a team |
| Sitter Q4–5             | Machine events as first-class triggers; cross-group communication patterns                        |
| Builder/Reviewer Q1     | The role-definition/spawn-brief schema                                                            |
| Builder/Reviewer Q2–3   | Workspace mutex design; whether role _isolation_ needs platform support (reviewer independence)   |
| SQL                     | Real volumes and latencies to size the inbox, stall thresholds, and dashboard density against     |
