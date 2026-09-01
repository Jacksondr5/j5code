# J5 A2A runtime configuration

`envelopes.v1.json` is the human-owned wording source for every injected A2A envelope and the two MCP tool descriptions. Templates use literal `{{name}}` placeholders; `EnvelopeFormatter.ts` is the only renderer. Change wording in the JSON file, keep every referenced placeholder, and bump `version` when the rendered contract changes.

`delivery-config.v1.json` owns the retry backoff and alarm threshold. Attempts reuse one upstream command/message id pair derived from the durable ledger message id. Increasing an attempt never rotates those ids: a permanently rejected upstream receipt must become a visible alarm rather than risk a second injection.

Production includes a non-agent-invocable home registrar for sanctioned creation paths. `registerAtCreation` accepts only an explicit existing squadron, records one immutable `participant.joined`, replays the same creation without another event, and rejects a different requested home. `getHomeForThread` reads historical join events so later lifecycle retirement cannot erase or reassign a thread's home. The registrar never creates, selects, moves, or leaves squadrons, and it is not an agent tool.

Placement and provenance are an agent-only organization overlay. Creation records immutable typed provenance (`spawned-by`, `forked-from`, or `unknown`) and derives the initial placement from that fact. Humans and person ids are never placement-tree nodes. This extraction ships no reparent or cascade command surface; the retained R21 human-only reparent law and Crew lifecycle recovery contracts live in the A6 ticket record.

No native user-created-thread hook consumes the registrar. Such threads remain explicit nonparticipants: `send_message` and `list_participants` fail closed when the caller has no home. There is no default Squadron, agent-created home, move action, or production seeding helper.

Human-inbox routes currently authenticate the environment scope, not the named person. The caller supplies the `human:<person-id>` used for reads and attributed answers; person-bound authentication remains deferred to X4's peer registry. Until that identity seam lands, an `orchestration:read` session can read any known person's inbox and an `orchestration:operate` session can answer as any known person.

The first J5 runtime start mints one opaque, durable `human:<person-id>` local-operator record in the host registry. A person is host-global addressability state: minting creates no Squadron, default, home, or membership event. The participant union remains broad enough to read historical human membership facts, while the live Squadron membership projection is agent-only; participant directories synthesize registered people alongside member agents.

For a cross-squadron send, the receiver ledger's idempotent `message.received` records durable acceptance of the sender's act before transport is attempted. It does not claim successful thread injection: delivery success, retries, and the terminal alarm remain in the sender squadron's delivery projection.

Byte-equivalent rebuilds for the A2 exchange and delivery projections are deferred to the measured-projections milestone (M5). A2 keeps those tables derivable from the communication ledger but does not expose their rebuild operation.

A3 requires every sent-message event and delivery row to declare an explicit envelope channel. Peer sends write `peer`; silence notices write `silence_notice`, reuse A2's versioned silence-notice formatter, and bypass peer/human wrapping in the shared transport.

The silence detector checkpoints its global v2 event sequence in the J5 migration lane. A new installation first reconciles only open delivered exchanges against current thread projections, records the existing v2 high-water mark, and then tails from that durable cursor; retries replay at most the uncheckpointed tail instead of scanning the event store from genesis on every boot. A broken v2 subscription uses capped exponential backoff without re-running the reconciliation scan on every attempt.

Archive closure is a separate platform lifecycle write authority in `LifecycleService.ts`; it is never an A3 silence action and is not exposed through the agent MCP toolkit. Participant archive appends `participant.left` with the complete original agent identity, then terminates every affected open exchange with `exchange.dropped` plus one stable platform-authored `lifecycle_notice` delivery. The existing membership projector removes retired participants from active reads while the append-only ledger remains readable indefinitely.

Squadron archive behavior and its user surface are deferred to the SC4 polished-later archive flow. This layer deliberately has no Squadron archive command, event, projection column, HTTP route, MCP tool, or warning/confirmation path; that future feature can compose the participant termination machinery once its product contract ships.

The bounded lifecycle reactor consumes committed `thread.archived` and `thread.deleted` events from a durable cursor and applies that same idempotent termination authority. Native threads without an A2A home are explicit no-ops. A later upstream `thread.unarchived` event does not revive the retired A2A participant: dropped exchanges and notices remain historical facts, and participation cannot resume until a separately ratified re-entry lifecycle exists.

`ArchiveFactsService.ts` is the read-only AR2 boundary for a future human pre-archive dialog. It reports open exchanges in both directions without deciding archive or settle policy. Placement is supplied through a provider whose current production result is explicitly `unknown`; a checked empty subtree is a different `none` state. HTTP registration on the sanctioned A4 routes layer remains deferred, and the measured MCP option is rejected because an agent tool is the wrong consumer for a human archive dialog.

A2S `archive_agent` composes these public boundaries directly: `ArchiveFactsService` supplies the AR2 preflight read and `LifecycleService.archiveParticipant` supplies the same idempotent R1 termination engine used by the lifecycle reactor. The agent-facing composition remains single-target, signs fact-bound confirmation tokens without a new store, and reads durable lifecycle evidence before returning `already_archived`. A9 itself still owns no agent tool or parallel handler.
