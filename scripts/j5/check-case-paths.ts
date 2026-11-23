// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a synchronous CI check run as a standalone Node script.
// Fails when two tracked files under apps/ or packages/ can be imported by stems that differ only
// in case, such as `./PersonaSheet` for both PersonaSheet.tsx and personaSheet.ts: on macOS and
// Windows the import can resolve to the wrong one. A stem paired only with a file that is
// imported by its extension, such as PdfViewer.tsx with pdfViewer.css, is not a collision.
import * as NodeChildProcess from "node:child_process";

const IMPORTABLE = /\.(?:[cm]?[jt]sx?)$/;

/** Groups of importable stems that differ only in case, each sorted. */
export function caseCollisions(paths: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> {
  const stemsByFolded = new Map<string, Set<string>>();
  for (const path of paths) {
    if (!IMPORTABLE.test(path)) continue;
    const stem = path.replace(/\.[^./]*$/, "");
    const folded = stem.toLowerCase();
    stemsByFolded.set(folded, (stemsByFolded.get(folded) ?? new Set()).add(stem));
  }
  return [...stemsByFolded.values()]
    .filter((stems) => stems.size > 1)
    .map((stems) => [...stems].toSorted());
}

if (import.meta.main) {
  const paths = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "apps", "packages"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const collisions = caseCollisions(paths);
  if (collisions.length > 0) {
    console.error("Importable paths that differ only in case (rename one of each group):");
    for (const group of collisions) console.error(`  ${group.join("  ")}`);
    process.exit(1);
  }
  console.log("No importable paths differ only in case.");
}
