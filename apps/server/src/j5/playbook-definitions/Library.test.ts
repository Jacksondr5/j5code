// @effect-diagnostics nodeBuiltinImport:off - isolated temporary filesystem fixture.
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createPlaybookLibrary } from "./Library.ts";
import { compileYamlPlaybook } from "./Yaml.ts";

const source = NodeFS.readFileSync(new URL("./research-review.yaml", import.meta.url), "utf8");

it("isolates invalid files and applies imported, configured, and shipped precedence", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-library-"));
  try {
    const configured = NodePath.join(stateDir, "playbooks");
    NodeFS.mkdirSync(configured);
    NodeFS.writeFileSync(NodePath.join(configured, "broken.yaml"), "schema: broken\n");
    const shipped = compileYamlPlaybook(source, "shipped.yaml");
    const library = createPlaybookLibrary(stateDir, [shipped]);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.source, "shipped");
    assert.equal(library.catalog().filter((item) => item.diagnostics.length).length, 1);

    const replacement = source.replace("version: 1", "version: 2");
    assert.throws(
      () => library.import([{ name: "replacement.yaml", content: replacement }]),
      /Confirm/,
    );
    library.import([{ name: "replacement.yaml", content: replacement }], true);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.canRemove, true);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.definition?.version, 2);
    library.setEnabled(shipped.id, false);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.enabled, false);
    library.remove(shipped.id);
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.source, "shipped");
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.canRemove, false);
    assert.throws(() => library.remove(shipped.id), /cannot be removed/);

    library.snapshot(shipped);
    assert.equal(library.savedDefinitions()[0]?.hash, shipped.hash);
    assert.isTrue(
      NodeFS.existsSync(NodePath.join(stateDir, "playbook-snapshots", `${shipped.hash}.yaml`)),
    );
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});

it("removes managed definitions while preserving snapshots and external definitions", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-library-"));
  try {
    const managedFolder = NodePath.join(stateDir, "playbooks");
    const managedFile = NodePath.join(managedFolder, "replacement.yaml");
    NodeFS.mkdirSync(managedFolder);
    NodeFS.writeFileSync(managedFile, source.replace("version: 1", "version: 2"));
    const shipped = compileYamlPlaybook(source, "shipped.yaml");
    const managed = compileYamlPlaybook(NodeFS.readFileSync(managedFile, "utf8"), managedFile);
    const library = createPlaybookLibrary(stateDir, [shipped]);
    library.snapshot(managed);

    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.canRemove, true);
    library.remove(shipped.id);
    assert.isFalse(NodeFS.existsSync(managedFile));
    assert.equal(library.catalog().find((item) => item.id === shipped.id)?.source, "shipped");
    assert.equal(
      library.loadSnapshot({
        definitionId: managed.id,
        definitionVersion: managed.version,
        definitionHash: managed.hash,
      })?.hash,
      managed.hash,
    );

    const externalFolder = NodePath.join(stateDir, "external-playbooks");
    const externalFile = NodePath.join(externalFolder, "external.yaml");
    NodeFS.mkdirSync(externalFolder);
    NodeFS.writeFileSync(externalFile, source.replace("version: 1", "version: 3"));
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "playbooks.json"),
      JSON.stringify({ folders: [externalFolder] }),
    );
    const externalLibrary = createPlaybookLibrary(stateDir, [shipped]);
    assert.equal(
      externalLibrary.catalog().find((item) => item.id === shipped.id)?.canRemove,
      false,
    );
    assert.throws(() => externalLibrary.remove(shipped.id), /cannot be removed/);
    assert.isTrue(NodeFS.existsSync(externalFile));
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});

it("supports playbooks folder recursively and playbooks.json config", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-library-"));
  try {
    const playbooksDir = NodePath.join(stateDir, "playbooks", "subfolder");
    NodeFS.mkdirSync(playbooksDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(playbooksDir, "custom.yaml"), source);
    const library = createPlaybookLibrary(stateDir, []);
    assert.equal(library.catalog().length, 1);
    assert.equal(library.catalog()[0]?.source, "configured");

    // playbooks.json override
    const customDir = NodePath.join(stateDir, "custom-playbooks");
    NodeFS.mkdirSync(customDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "playbooks.json"),
      JSON.stringify({ folders: ["custom-playbooks"] }),
    );
    const configuredLibrary = createPlaybookLibrary(stateDir, []);
    assert.equal(configuredLibrary.catalog().length, 0);

    NodeFS.writeFileSync(NodePath.join(customDir, "custom2.yaml"), source);
    const configuredLibrary2 = createPlaybookLibrary(stateDir, []);
    assert.equal(configuredLibrary2.catalog().length, 1);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});

it("ignores workflow storage files", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-library-"));
  try {
    const legacyDefinitions = NodePath.join(stateDir, "workflow-definitions");
    const legacySnapshots = NodePath.join(stateDir, "workflows", "definitions");
    NodeFS.mkdirSync(legacyDefinitions);
    NodeFS.mkdirSync(legacySnapshots, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(legacyDefinitions, "configured.yaml"), source);
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "workflow-definitions.json"),
      JSON.stringify({ folders: ["workflow-definitions"] }),
    );
    NodeFS.writeFileSync(
      NodePath.join(stateDir, "imported-workflows.json"),
      JSON.stringify([{ name: "imported.yaml", content: source, enabled: true }]),
    );
    const definition = compileYamlPlaybook(source);
    NodeFS.writeFileSync(NodePath.join(legacySnapshots, `${definition.hash}.yaml`), source);

    const library = createPlaybookLibrary(stateDir, []);
    assert.deepEqual(library.catalog(), []);
    assert.deepEqual(library.savedDefinitions(), []);
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});

it("loads an exact snapshot written after library startup", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-library-"));
  try {
    const definition = compileYamlPlaybook(source);
    const staleLibrary = createPlaybookLibrary(stateDir, []);
    createPlaybookLibrary(stateDir, []).snapshot(definition);

    assert.equal(
      staleLibrary.loadSnapshot({
        definitionId: definition.id,
        definitionVersion: definition.version,
        definitionHash: definition.hash,
      })?.hash,
      definition.hash,
    );
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});

it("rejects invalid, altered, and incompatible snapshot identities", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "playbook-library-"));
  try {
    const definition = compileYamlPlaybook(source);
    const snapshots = NodePath.join(stateDir, "playbook-snapshots");
    NodeFS.mkdirSync(snapshots);
    const library = createPlaybookLibrary(stateDir, []);
    const identity = {
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: definition.hash,
    };

    assert.isUndefined(library.loadSnapshot({ ...identity, definitionHash: "../state.sqlite" }));
    assert.isUndefined(library.loadSnapshot(identity));

    NodeFS.writeFileSync(NodePath.join(snapshots, `${definition.hash}.yaml`), "schema: broken\n");
    assert.isUndefined(library.loadSnapshot(identity));

    NodeFS.writeFileSync(
      NodePath.join(snapshots, `${definition.hash}.yaml`),
      source.replace("version: 1", "version: 2"),
    );
    assert.isUndefined(library.loadSnapshot(identity));

    NodeFS.writeFileSync(NodePath.join(snapshots, `${definition.hash}.yaml`), source);
    assert.isUndefined(library.loadSnapshot({ ...identity, definitionId: "other" }));
    assert.isUndefined(library.loadSnapshot({ ...identity, definitionHash: "0".repeat(64) }));
  } finally {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  }
});
