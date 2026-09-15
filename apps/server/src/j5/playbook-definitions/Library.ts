// @effect-diagnostics nodeBuiltinImport:off - synchronous catalog construction precedes service startup.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Definition } from "../playbook/Definition.ts";
import { compileYamlPlaybook } from "./Yaml.ts";

export interface PlaybookCatalogEntry {
  readonly id: string;
  readonly definition?: Definition;
  readonly title: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly source: "imported" | "configured" | "shipped";
  readonly diagnostics: readonly string[];
}

type StoredImport = { readonly name: string; readonly content: string; readonly enabled: boolean };
const importsFile = (stateDir: string) => NodePath.join(stateDir, "imported-playbooks.json");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(NodeFS.readFileSync(file, "utf8")) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw cause;
  }
}

function filesIn(folder: string): Array<{ name: string; content: string }> {
  try {
    const results: Array<{ name: string; content: string }> = [];
    const walk = (dir: string, depth: number) => {
      const entries = NodeFS.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        const fullPath = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith(".") && depth < 16) {
            walk(fullPath, depth + 1);
          }
        } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
          results.push({
            name: fullPath,
            content: NodeFS.readFileSync(fullPath, "utf8"),
          });
        }
      }
    };
    walk(folder, 0);
    return results;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw cause;
  }
}

const persist = (stateDir: string, imports: readonly StoredImport[]) => {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const target = importsFile(stateDir);
  const temporary = `${target}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, JSON.stringify(imports, null, 2), { mode: 0o600 });
  NodeFS.renameSync(temporary, target);
};

export function createPlaybookLibrary(
  stateDir: string,
  shipped: readonly Definition[],
  implementations: Readonly<Record<string, Definition>> = {},
) {
  let imports = readJson<StoredImport[]>(importsFile(stateDir), []);
  const configuredFolders = () => {
    const configFile = NodePath.join(stateDir, "playbooks.json");
    if (NodeFS.existsSync(configFile)) {
      const config = readJson<{ folders: string[] }>(configFile, { folders: [] });
      return config.folders.map((folder) => NodePath.resolve(stateDir, folder));
    }
    return [NodePath.join(stateDir, "playbooks")];
  };
  const compileLayer = (
    source: PlaybookCatalogEntry["source"],
    files: readonly { name: string; content: string; enabled?: boolean }[],
  ) => {
    const compiled = files.map((file) => {
      try {
        return {
          file,
          definition: compileYamlPlaybook(file.content, file.name, implementations),
        };
      } catch (cause) {
        return { file, cause };
      }
    });
    const counts = new Map<string, number>();
    for (const item of compiled)
      if (item.definition)
        counts.set(item.definition.id, (counts.get(item.definition.id) ?? 0) + 1);
    return compiled.map((item): PlaybookCatalogEntry => {
      const duplicate = item.definition && counts.get(item.definition.id)! > 1;
      if (item.definition && !duplicate)
        return {
          id: item.definition.id,
          definition: item.definition,
          title: item.definition.title ?? item.definition.id,
          description: item.definition.description ?? "",
          enabled: item.file.enabled ?? true,
          source,
          diagnostics: [],
        };
      return {
        id: `invalid:${source}:${item.file.name}`,
        title: NodePath.basename(item.file.name),
        description: "Invalid playbook definition",
        enabled: false,
        source,
        diagnostics: [
          duplicate
            ? `Duplicate playbook id ${item.definition!.id} in ${source} layer`
            : String(item.cause),
        ],
      };
    });
  };
  const catalog = () => {
    const shippedEntries: PlaybookCatalogEntry[] = shipped.map((definition) => ({
      id: definition.id,
      definition,
      title: definition.title ?? definition.id,
      description: definition.description ?? "",
      enabled: true,
      source: "shipped",
      diagnostics: [],
    }));
    const configured = compileLayer("configured", configuredFolders().flatMap(filesIn));
    const imported = compileLayer("imported", imports);
    const visible = new Map<string, PlaybookCatalogEntry>();
    for (const layer of [shippedEntries, configured, imported])
      for (const entry of layer) visible.set(entry.id, entry);
    return [...visible.values()];
  };
  return {
    catalog,
    loadSnapshot(identity: {
      readonly definitionId: string;
      readonly definitionVersion: number;
      readonly definitionHash: string;
    }) {
      if (!/^[0-9a-f]{64}$/.test(identity.definitionHash)) return undefined;
      try {
        const file = NodePath.join(
          stateDir,
          "playbook-snapshots",
          `${identity.definitionHash}.yaml`,
        );
        const definition = compileYamlPlaybook(
          NodeFS.readFileSync(file, "utf8"),
          file,
          implementations,
        );
        return definition.id === identity.definitionId &&
          definition.version === identity.definitionVersion &&
          definition.hash === identity.definitionHash
          ? definition
          : undefined;
      } catch {
        return undefined;
      }
    },
    savedDefinitions() {
      return filesIn(NodePath.join(stateDir, "playbook-snapshots")).flatMap((file) => {
        try {
          const definition = compileYamlPlaybook(file.content, file.name, implementations);
          return NodePath.basename(file.name, NodePath.extname(file.name)) === definition.hash
            ? [definition]
            : [];
        } catch {
          return [];
        }
      });
    },
    snapshot(definition: Definition) {
      if (!definition.source) return;
      const folder = NodePath.join(stateDir, "playbook-snapshots");
      NodeFS.mkdirSync(folder, { recursive: true });
      const target = NodePath.join(folder, `${definition.hash}.yaml`);
      if (NodeFS.existsSync(target)) return;
      const temporary = `${target}.${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, definition.source, { mode: 0o600 });
      NodeFS.renameSync(temporary, target);
    },
    import(files: readonly { name: string; content: string }[], confirmConflicts = false) {
      if (files.length === 0 || files.length > 50) throw new Error("Import requires 1 to 50 files");
      for (const file of files) {
        if (!/\.ya?ml$/i.test(file.name))
          throw new Error(`Playbook files must be YAML: ${file.name}`);
        if (Buffer.byteLength(file.content, "utf8") > 262144)
          throw new Error(`Playbook file exceeds 256 KiB: ${file.name}`);
      }
      const incoming = compileLayer("imported", files);
      const invalid = incoming.flatMap((entry) => entry.diagnostics);
      if (invalid.length) throw new Error(invalid.join("\n"));
      const conflicts = incoming.filter((entry) =>
        catalog().some((current) => current.id === entry.id),
      );
      if (conflicts.length && !confirmConflicts)
        throw new Error(`Confirm replacement of: ${conflicts.map((entry) => entry.id).join(", ")}`);
      const incomingIds = new Set(incoming.map((entry) => entry.id));
      imports = [
        ...imports.filter((item) => {
          try {
            return !incomingIds.has(
              compileYamlPlaybook(item.content, item.name, implementations).id,
            );
          } catch {
            return true;
          }
        }),
        ...files.map((file) => ({ ...file, enabled: true })),
      ];
      persist(stateDir, imports);
      return catalog();
    },
    setEnabled(id: string, enabled: boolean) {
      let found = false;
      imports = imports.map((item) => {
        try {
          if (compileYamlPlaybook(item.content, item.name, implementations).id !== id) return item;
          found = true;
          return { ...item, enabled };
        } catch {
          return item;
        }
      });
      if (!found) throw new Error(`Only imported playbooks can be enabled or disabled: ${id}`);
      persist(stateDir, imports);
      return catalog();
    },
    remove(id: string) {
      const before = imports.length;
      imports = imports.filter((item) => {
        try {
          return compileYamlPlaybook(item.content, item.name, implementations).id !== id;
        } catch {
          return true;
        }
      });
      if (imports.length === before) throw new Error(`Unknown imported playbook ${id}`);
      persist(stateDir, imports);
      return catalog();
    },
  };
}
