import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Oldest Codex CLI whose app-server protocol matches the generated schema in
 * `packages/effect-codex-app-server`. Older CLIs omit fields the schema now
 * requires (thread `projectId`, item timestamps, `functionCallOutput` items), so
 * their responses fail decode and would otherwise degrade into silent fallbacks.
 */
export const MINIMUM_CODEX_CLI_VERSION = "0.151.0";

export class CodexCliVersionUnsupportedError extends Schema.TaggedErrorClass<CodexCliVersionUnsupportedError>()(
  "CodexCliVersionUnsupportedError",
  {
    minimumVersion: Schema.String,
    foundVersion: Schema.String,
    userAgent: Schema.String,
  },
) {
  override get message(): string {
    return `J5 requires Codex CLI ≥ ${this.minimumVersion}; found ${this.foundVersion}`;
  }
}

const CLI_VERSION_PATTERN = /^[^/\s]+\/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?=\s|$)/u;

interface ParsedCliVersion {
  readonly text: string;
  readonly core: readonly [number, number, number];
  readonly prerelease: boolean;
}

function parseCliVersion(version: string): ParsedCliVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/u.exec(version);
  if (match === null) return null;
  return {
    text: version,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/**
 * Codex reports `<originator>/<cli version> (<os>) ...` as the initialize
 * `userAgent`; the segment after the first slash is the CLI's own version.
 */
export function codexCliVersionFromUserAgent(userAgent: string): string | null {
  const match = CLI_VERSION_PATTERN.exec(userAgent.trim());
  if (match === null) return null;
  return `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`;
}

/** Semver-style ordering: numeric core first; a prerelease sorts below its release. */
export function compareCodexCliVersions(left: string, right: string): number {
  const a = parseCliVersion(left);
  const b = parseCliVersion(right);
  if (a === null || b === null) {
    throw new Error(`Cannot compare Codex CLI versions '${left}' and '${right}'.`);
  }
  for (let index = 0; index < 3; index += 1) {
    const delta = a.core[index]! - b.core[index]!;
    if (delta !== 0) return Math.sign(delta);
  }
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease ? -1 : 1;
}

/**
 * Fails closed when the app-server that answered `initialize` is older than
 * the schema floor or does not report a parseable version.
 */
export function assertSupportedCodexCliVersion(
  userAgent: string,
  minimumVersion: string = MINIMUM_CODEX_CLI_VERSION,
): Effect.Effect<void, CodexCliVersionUnsupportedError> {
  const foundVersion = codexCliVersionFromUserAgent(userAgent);
  if (foundVersion === null) {
    return Effect.fail(
      new CodexCliVersionUnsupportedError({
        minimumVersion,
        foundVersion: `unknown (userAgent "${userAgent}")`,
        userAgent,
      }),
    );
  }
  if (compareCodexCliVersions(foundVersion, minimumVersion) < 0) {
    return Effect.fail(
      new CodexCliVersionUnsupportedError({ minimumVersion, foundVersion, userAgent }),
    );
  }
  return Effect.void;
}

const isCodexCliVersionUnsupportedError = Schema.is(CodexCliVersionUnsupportedError);

/** Walks a wrapped error's `cause` chain for the version gate failure, if any. */
export function findCodexCliVersionUnsupportedError(
  error: unknown,
): CodexCliVersionUnsupportedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth += 1) {
    if (isCodexCliVersionUnsupportedError(current)) return current;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return undefined;
}
