# J5 documentation

Everything about J5 Code — the product built on this fork of T3 Code — lives under `docs/j5/`. Upstream's own documentation (`docs/user/`, `docs/internals/`, `docs/operations/`) is left as upstream wrote it; J5 never edits it.

Every document here is one of five kinds, and the kind tells you how far to trust it: **definitions** describe the product and are kept true; **plans** sequence work and are history once executed; **research** reports what we learned as of a date; **records** say what happened on a day; **runbooks** tell an operator what to do. The kinds, their lifetimes, the identifier scheme, and the rules for changing a definition are in [how the docs are organized](process/docs.md) — read it before writing anything here.

## Reading order for newcomers

1. [Problems and goals](product/problems.md) — what hurts and what is wanted, in Jackson's voice.
2. [Fleet vision](product/fleet-vision.md) — why this exists: the operating model and the thesis.
3. [Principles](product/principles.md) — the beliefs, lenses and principles that turn the problems into product.
4. [Use cases](product/use-cases.md) — the concrete fleets every feature is tested against.
5. [Glossary](product/glossary.md) — the vocabulary; every name in these docs resolves here.
6. [Agent-to-agent communication](product/a2a/index.md), then [Squadron](product/features/squadron.md) — the two definitions everything else stands on.
7. The rest of [`product/features/`](product/features/) — the feature definitions of record.
8. [Research synthesis](research/synthesis.md) — what we learned from T3 Code and Traycer.

## Contents

- **`product/`** — definitions: the core documents above, the [A2A trio](product/a2a/) (the communication protocol, the upstream substrate, the agent tool contracts), and [`features/`](product/features/) (Squadron, inbox, thread rendering, archive flow, Roles, Crews, Memos, Playbooks, Spawning Guide, sidebar and roster, PR pane, Shared Squadrons).
- **`plans/`** — the [dogfood v0 plan](plans/dogfood-v0.md) and the [A2A plan](plans/a2a.md). Build status against a definition's criteria lives only here. The backlog beyond these is the repository's GitHub milestones, in outcome order.
- **`research/`** — the studies behind the decisions: T3 Code, Traycer, the prior-art fleets, remote hosting. Each carries an `as_of` date; none is a source of truth about the product.
- **`worklog/`** — records, named date-first: design sessions and rulings, the tickets and reviews of the A2A build and the dogfood queue, how the fork was set up, the phase-3 friction list.
- **`runbooks/`** — operating the software: the [dogfood runtime](runbooks/dogfood-runtime.md), [agent migration](runbooks/agent-migration.md), [macOS packaging](runbooks/macos-packaging.md).
- **`process/`** — rules for working in this repository: [how the docs are organized](process/docs.md) and [working in the repo](process/working-in-the-repo.md). How the fleet is run day to day is the operator's own practice and lives outside the repository.

Cross-references are relative paths and survive within this tree.
