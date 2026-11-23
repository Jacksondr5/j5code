# Product usage data

This page replaces T3 Code's [product usage data](../../user/telemetry.md) guide for J5 Code:
J5 Code sends its events somewhere else, and sends more of them.

The J5 Code server sends product usage events to J5 Code's own PostHog project, associated with a
hashed account or installation identifier. To count how many installations one person uses, the
server also sends hashed account identifiers: your T3 Connect account, your OpenAI and Claude
accounts when you are signed in, and a random identifier for each device that connects. Events
include the provider, model, reasoning effort, permission mode, turn result, duration, release
channel, and main-agent token totals when available. They also name the features you use, such as
replying in the Inbox, deciding on a Crew roster or sharing with someone, and the tools agents
call, without paths, IDs, or text. Each turn that starts is also reported with who asked for it
(you, an agent, or the server itself), whether a scheduled task started it, and whether the thread
is a seat in a Crew. When an ask between participants ends, the event says how it ended, what kind
of participant was on each side, its urgency, and how long it was open. A playbook run reports its
step count when it starts, and the step it reached when it completes or is cancelled. A Crew
reports how many seats started when it launches. Every fifteen minutes the server reports counts
of working threads, live Crews and waiting asks.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs,
raw provider events, or child-agent output. Child-agent token use is excluded from the totals.
When an event arrives, PostHog looks up an approximate location (country, region, city, postcode
and coordinates) from the IP address of the machine running the server, which is often your own
computer, and stores it with the event. The IP address itself is not stored.

Builds that set a relay trace destination also send relay connection traces to Axiom to diagnose
T3 Connect connectivity. J5 Code's releases set none.

To disable product events and relay tracing, set `T3CODE_TELEMETRY_ENABLED=false` in the server's
environment before starting it. Relay tracing also stops when `T3CODE_OTEL_SDK_DISABLED` or
`OTEL_SDK_DISABLED` turns OpenTelemetry export off. The web app in a browser, including one the
`j5` CLI opens, does not read these variables.

To label your own events, for example while testing a build, set `J5CODE_TELEMETRY_TAG` to a short
label of your choice in the server's environment. The label is sent with every event. It is not
read from your shell profile by the desktop app.

The desktop app reads `T3CODE_TELEMETRY_ENABLED` from your shell profile (for example `~/.zshrc`)
on macOS and Linux, so export it there and restart the app. On Windows, set it as a user
environment variable.

Exporting diagnostics to your own OpenTelemetry receiver works as T3 Code's guide
[describes](../../user/telemetry.md#export-diagnostics-to-your-own-receiver).
