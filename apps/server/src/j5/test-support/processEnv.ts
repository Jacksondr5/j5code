import * as Effect from "effect/Effect";

type ProcessEnvValues = Readonly<Record<string, string | undefined>>;

const applyProcessEnv = (values: ProcessEnvValues): ProcessEnvValues => {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return previous;
};

// Code under test reads NodeOS.homedir() or spawns children, so only the real process
// environment reaches it. Restored when the test's scope closes.
export const setProcessEnv = (values: ProcessEnvValues) =>
  Effect.acquireRelease(
    Effect.sync(() => applyProcessEnv(values)),
    (previous) => Effect.sync(() => applyProcessEnv(previous)),
  );

export const setProcessHome = (home: string) => setProcessEnv({ HOME: home, USERPROFILE: home });
