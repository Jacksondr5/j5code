---
title: "Research: T3 Code & Traycer deep dives"
kind: story
status: 2
---

# Research: T3 Code & Traycer

Goal: build a full picture of both apps before designing our own AI-agent-fleet desktop app. For each app we want:

1. **Feature inventory** — every user-facing feature, with a short description of how it works.
2. **Architecture map** — processes, tech stack, key packages, data flow, persistence, IPC.
3. **Deep dives** — the features we most want to learn from:

- T3 Code: remote/multi-machine capabilities; the engineering practices behind its performance and quality.
- Traycer: agent-to-agent peer messaging (MCP server / broker), epic → hierarchy → artifact organization, multi-folder workspaces; root causes of its performance problems (UI freezes, thread-jumping, large-thread slowdown).

4. **Quality assessment** — code health, test coverage, patterns worth stealing, patterns to avoid.

Sub-artifacts (written by the research agents):

- `t3code/` — T3 Code findings
- `traycer/` — Traycer findings

These feed the next phase: product definition and architecture design for the new app.
