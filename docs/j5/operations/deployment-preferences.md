---
title: "Deployment design preferences — how Jackson wants services run"
kind: spec
---

# Deployment design preferences

Jackson's stated preferences for how services are designed and deployed on his machines. These are
**preferences that shape design decisions**, recorded so they are not re-asked. The concrete
deployment **state** — ports, the systemd unit, the Ansible tasks, which tailnet ports are taken —
lives in [`dogfood-runtime.md`](../dogfood-runtime.md) and its Deployment parameters table; keep
that table as the single home for state, and this doc for the _why_.

## The template to preserve

Jackson runs services as **pinned-version, per-user systemd services reconciled by Ansible** — a
dedicated non-sudo service user with lingering enabled, a unit under
`~/.config/systemd/user/`, a loopback-only listener reached over Tailscale, and exact-version pins
applied by an Ansible playbook run twice to confirm idempotence. He never uses `npx <pkg>@latest` or
in-app self-update. When designing deployment for anything new on his machines, **mirror this
template instead of inventing a mechanism**. (J5's one deliberate variation: the "pinned version" is
a git checkout rather than an npm package, because the fork builds from source — see the runtime
doc.)

## Stated design preferences

- **Fix defaults in code; don't rely on env vars.** When a fork or app has a wrong default (the
  motivating case: the J5 server originally defaulting its state dir to the upstream `~/.t3`), change
  the default in code rather than documenting an environment-variable override that people must
  remember to set.
- **Don't overengineer version pinning for dogfood-grade operations.** For the self-hosted
  dev-branch server, "get latest from source" is good enough. He declined tagged-checkpoint /
  last-known-good machinery beyond trivialities like printing the previous git ref before an update.
- **Restart discipline over restart engineering.** Waiting for the fleet to go quiet before
  restarting the server is acceptable operating practice; do not engineer around restart-under-load.
- **New services take non-conflicting ports and never disturb the existing upstream T3 service's
  listener.** The specific assignments are state and live in the runtime doc.
