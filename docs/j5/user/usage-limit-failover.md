# Continue work after a provider reaches its usage limit

Automatic provider failover is opt-in and disabled by default. It applies to Codex and Claude subscription instances. A limited thread keeps its identity, workspace, branch and parent; J5 selects an available authorized route, transfers context using its existing handoff, and continues the unfinished objective. The continuation inspects the working tree because context handoffs can omit tool activity.

The environment owner can configure `usageLimitFailover` through the existing server-settings API. Use the instance IDs and advertised model selections from that environment:

```json
{
  "usageLimitFailover": {
    "enabled": true,
    "routes": [
      { "instanceId": "codex", "model": "YOUR_CODEX_MODEL" },
      { "instanceId": "claudeAgent", "model": "YOUR_CLAUDE_MODEL" }
    ],
    "maxHops": 4,
    "subscriptionOnlyInstances": ["codex", "claudeAgent"]
  }
}
```

Before adding an instance to `subscriptionOnlyInstances`, confirm it uses subscription authentication, Codex purchased credits are unavailable, and Claude Extra usage is disabled. This is an explicit owner attestation. J5 additionally rejects observed paid usage and paid-usage availability, and never redeems reset credits. It cannot prevent an external account setting from changing between observations.

Ordinary threads use the ordered routes. Persona threads use their pinned primary/fallback pair. A route must preserve the approved permissions and support the current runtime and interaction modes. A `workspace-write` Builder cannot move to Claude unless its Crew seat already has an explicit approved runtime-mode override. Persona model overrides and `critic-fix` assignments cannot switch automatically. Other providers are unsupported in this version.

When all eligible routes are exhausted, the thread stays failed and J5 checks availability again through its existing scheduler. Recovery requests a bounded provider health refresh at most once per minute per attested instance, even with no client connected; provider probe caches may delay a new observation. A failure without a reset time requires a newer complete usage probe before retrying that instance; sparse or stale updates cannot clear it. Shared and model-scoped quota windows conservatively block the entire provider instance. If a switch commits before a restart, J5 resumes the continuation phase on its next sweep. Thread notices report a switch, suspension, or a pending retry.

Set `enabled` to `false` to stop automatic failover. Existing same-provider reset recovery remains controlled by `autoResumeLimitedThreads` and `snoozeLimitedThreads`. Disabling failover between a switch and its continuation leaves the thread waiting for an explicit continuation or re-enablement. There is no proactive failback.

For controlled validation, first build and test the reviewed source in a separate checkout and isolated J5 home, with distinct ports and no live database or provider sessions copied into it. Run the adapter-stub recovery tests before enabling this setting on a disposable subscription-backed thread. Do not deliberately exhaust quotas or enable paid usage. Deploy to the real environment only after review and a successful isolated validation; preserve a database snapshot and the previous runtime for rollback.
