import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

const root = new URL("../", import.meta.url);
const files = [
  "apps/server/src/j5/workflow/Definition.ts",
  "apps/server/src/j5/workflow/Worker.ts",
  "apps/server/src/j5/workflow/AgentAdapter.ts",
  "apps/server/src/j5/workflow/Store.ts",
  "apps/server/src/j5/workflow-definitions/Service.ts",
  "apps/server/src/j5/workflow-definitions/manifest.ts",
  "packages/j5-workflow-contracts/src/index.ts",
  "apps/server/src/j5/workflow/decider.ts",
  "apps/server/src/j5/workflow-definitions/fh/development.ts",
  "apps/server/src/j5/workflow-definitions/fh/CodeAdapters.ts",
  "apps/server/src/j5/workflow-definitions/fh/GitWorkspace.ts",
  "apps/server/src/j5/workflow-definitions/fh/Publication.ts",
  "packages/j5-workflow-contracts/src/fh.ts",
];
const content = files.map((file) => [file, NodeFS.readFileSync(new URL(file, root), "utf8")]);
const hash = NodeCrypto.createHash("sha256").update(JSON.stringify(content)).digest("hex");
const target = new URL("apps/server/src/j5/workflow-definitions/manifest.json", root);
if (process.argv.includes("--check")) {
  const recorded = JSON.parse(NodeFS.readFileSync(target, "utf8"));
  if (recorded.hash !== hash || JSON.stringify(recorded.files) !== JSON.stringify(files)) {
    throw new Error(
      "Workflow definition sources changed. Review the changes, then run node scripts/j5-workflow-manifest.mjs before building.",
    );
  }
} else NodeFS.writeFileSync(target, JSON.stringify({ version: 1, files, hash }, null, 2) + "\n");
