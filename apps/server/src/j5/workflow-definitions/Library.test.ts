// @effect-diagnostics nodeBuiltinImport:off - isolated temporary filesystem fixture.
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createWorkflowLibrary } from "./Library.ts";
import { compileYamlWorkflow } from "./Yaml.ts";

const source = NodeFS.readFileSync(new URL("./research-review.yaml", import.meta.url), "utf8");

it("isolates invalid files and applies imported, configured, and shipped precedence", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-library-"));
  try {
    const configured = NodePath.join(stateDir, "workflow-definitions");
    NodeFS.mkdirSync(configured);
    NodeFS.writeFileSync(NodePath.join(configured, "broken.yaml"), "schema: broken\n");
    const shipped = compileYamlWorkflow(source, "shipped.yaml");
    const library = createWorkflowLibrary(stateDir, [shipped]);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.source, "shipped");
    assert.equal(library.catalog().filter((item) => item.diagnostics.length).length, 1);

    const replacement = source.replace("version: 1", "version: 2");
    assert.throws(
      () => library.import([{ name: "replacement.yaml", content: replacement }]),
      /Confirm/,
    );
    library.import([{ name: "replacement.yaml", content: replacement }], true);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.definition?.version, 2);
    library.setEnabled(shipped.id, false);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.enabled, false);
    library.remove(shipped.id);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.source, "shipped");

    library.snapshot(shipped);
    assert.equal(library.savedDefinitions()[0]?.hash, shipped.hash);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});
