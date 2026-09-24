import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface ForkFacts {
  /** Short SHA of the upstream commit the fork is pinned to. */
  pin: string;
  /** ISO date the pin was selected, from FORK.md. */
  pinSelectedOn: string | undefined;
  /** Number of inventoried integration cases into upstream-owned files. */
  integrationCases: number | undefined;
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
 * Reads the fork's upstream pin and integration inventory size from FORK.md at
 * build time so the Foundation section never carries a hand-typed number.
 * Returns undefined when the file or the sentence it depends on is missing, and
 * the page then omits the line rather than showing a stale value.
 */
export function readForkFacts(): ForkFacts | undefined {
  const file = findForkFile();
  if (!file) return undefined;

  const text = NodeFS.readFileSync(file, "utf8");
  const pin = /^Current pin: `([0-9a-f]{7,40})`(?: \(selected (\d{4}-\d{2}-\d{2}))?/m.exec(text);
  if (!pin?.[1]) return undefined;

  const cases = /the inventory has (\d+) cases/.exec(text);

  return {
    pin: pin[1].slice(0, 7),
    pinSelectedOn: pin[2],
    integrationCases: cases?.[1] ? Number(cases[1]) : undefined,
  };
}
