import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

const root = new URL("../", import.meta.url);
const files = [
  "apps/server/src/j5/playbook/Definition.ts",
  "apps/server/src/j5/playbook/Execution.ts",
  "apps/server/src/j5/playbook/Worker.ts",
  "apps/server/src/j5/playbook/AgentAdapter.ts",
  "apps/server/src/j5/playbook/Store.ts",
  "apps/server/src/j5/playbook/Migrations.ts",
  "apps/server/src/j5/playbook-definitions/Service.ts",
  "apps/server/src/j5/playbook-definitions/manifest.ts",
  "packages/j5-playbook-contracts/src/index.ts",
  "apps/server/src/j5/playbook/decider.ts",
  "apps/server/src/j5/playbook-definitions/fh/development.ts",
  "apps/server/src/j5/playbook-definitions/fh/CodeAdapters.ts",
  "apps/server/src/j5/playbook-definitions/fh/GitWorkspace.ts",
  "apps/server/src/j5/playbook-definitions/fh/Publication.ts",
  "packages/j5-playbook-contracts/src/fh.ts",
  "apps/server/src/j5/playbook-definitions/Yaml.ts",
  "apps/server/src/j5/playbook-definitions/Library.ts",
  "apps/server/src/j5/playbook-definitions/research-review.yaml",
  "apps/server/src/j5/playbook-definitions/fh/development.yaml",
  "apps/server/scripts/copy-playbook-yaml.mjs",
];
const content = files.map((file) => [file, NodeFS.readFileSync(new URL(file, root), "utf8")]);
const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
const target = new URL("apps/server/src/j5/playbook-definitions/manifest.json", root);
if (process.argv.includes("--check")) {
  const recorded = JSON.parse(NodeFS.readFileSync(target, "utf8"));
  if (recorded.hash !== hash || JSON.stringify(recorded.files) !== JSON.stringify(files)) {
    throw new Error(
      "Playbook definition sources changed. Review the changes, then run node scripts/j5-playbook-manifest.mjs before building.",
    );
  }
} else NodeFS.writeFileSync(target, JSON.stringify({ version: 3, files, hash }, null, 2) + "\n");
