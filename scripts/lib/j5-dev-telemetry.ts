/**
 * Where a dev server sends product usage events.
 *
 * Released builds report to the "J5 Code" PostHog project, the default in
 * `apps/server/src/telemetry/AnalyticsService.ts`. Dev servers report to "J5 Code Dev", so
 * development and agent test runs are not counted as real use. A PostHog project token only
 * accepts events, which is why both are in the source.
 */
export const J5_DEV_POSTHOG_KEY = "phc_wsX4hEiHn5j5njkeFEunQvCMPmLuCQtVkFSUn8gewr6H";

/** The dev project, unless the developer's shell or `.env` already names a project. */
export const j5DevPostHogKey = (env: NodeJS.ProcessEnv): string =>
  env.T3CODE_POSTHOG_KEY?.trim() || J5_DEV_POSTHOG_KEY;
