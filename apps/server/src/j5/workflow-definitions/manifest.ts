// @effect-diagnostics nodeBuiltinImport:off - source integrity check at module load; packaged builds use the checked embedded manifest.
import * as NodeFS from "node:fs";
import { hash } from "../workflow/Definition.ts";
import manifest from "./manifest.json" with { type: "json" };

/** Source edits change identity immediately; build:bundle checks the embedded hash before packaging. */
export function definitionHash(definitionUrl: string): string {
  if (!definitionUrl.endsWith(".ts")) return manifest.hash;
  const root = new URL("../../../../../../", definitionUrl);
  return hash(
    manifest.files.map((file) => [file, NodeFS.readFileSync(new URL(file, root), "utf8")]),
  );
}
