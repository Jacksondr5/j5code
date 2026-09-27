import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ForkFacts {
  /** Short SHA of the upstream commit the fork is pinned to. */
  pin: string;
  /** ISO date the pin was selected or frozen, from FORK.md. */
  pinSelectedOn: string | undefined;
}

/**
 * Locates FORK.md by walking up from the build's working directory. Astro
 * bundles this module before running it, so import.meta.url no longer points
 * into the source tree; the working directory (apps/marketing locally and on
 * Vercel) is the stable anchor.
 */
function findForkFile(): string | undefined {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const candidate = NodePath.join(dir, "FORK.md");
    if (NodeFS.existsSync(candidate)) return candidate;
    const parent = NodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Reads the fork's upstream pin from FORK.md at build time so the Foundation
 * section never carries a hand-typed commit.
 * Returns undefined when the file or the sentence it depends on is missing, and
 * the page then omits the line rather than showing a stale value.
 */
export function readForkFacts(): ForkFacts | undefined {
  const file = findForkFile();
  if (!file) return undefined;

  // FORK.md has written this line two ways so far:
  //   Current pin: `<sha>` (selected 2026-09-05; ...)
  //   Current candidate pin: `<sha>`, from `<branch>` (frozen 2026-09-24).
  const text = NodeFS.readFileSync(file, "utf8");
  const pin = /^Current (?:candidate )?pin: `([0-9a-f]{7,40})`([^\n]*)/m.exec(text);
  if (!pin?.[1]) return undefined;
  const date = /(?:selected|frozen) (\d{4}-\d{2}-\d{2})/.exec(pin[2] ?? "");

  return {
    pin: pin[1].slice(0, 7),
    pinSelectedOn: date?.[1],
  };
}
