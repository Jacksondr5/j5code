# Product usage data

The T3 Code server sends product usage events to PostHog, associated with a hashed account or
installation identifier. Events include the provider, model, reasoning effort, permission mode,
turn result, duration, and main-agent token totals when available. Each turn that starts is also
reported with who asked for it (you, an agent, or the server itself), whether a scheduled task
started it, and whether the thread is a seat in a Crew. When an ask between participants ends, the
event says how it ended, what kind of participant was on each side, its urgency, and how long it
was open. A playbook run reports its step count when it starts, and the step it reached when it
completes or is cancelled. A Crew reports the number of seats asked for, approved and changed when
you decide on its roster, and how many seats started when it launches.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.

To disable collection, set `T3CODE_TELEMETRY_ENABLED=false` in the server's environment before
starting it. This stops product events from being recorded or sent.

To label your own events, for example while testing a build, set `J5CODE_TELEMETRY_TAG` to a
short label of your choice in the server's environment. The label is sent with every event. It is
not read from your shell profile by the desktop app.

The desktop app reads the opt-out variable from your shell profile (for example `~/.zshrc`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.
