// The CLI installer lives in scripts/ at the repo root with the rest of the
// release tooling; the site serves it at https://j5.codes/install.sh so the
// documented command stays short. Copy it into public/ before every dev
// server and build so the two never drift. The copy is gitignored. Fail
// loudly if the source is missing (for example a Vercel build without files
// outside the root directory), rather than deploying a dead URL.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const marketingDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const repoRoot = NodePath.dirname(NodePath.dirname(marketingDir));
const source = NodePath.join(repoRoot, "scripts", "install.sh");
const publicDir = NodePath.join(marketingDir, "public");

if (!NodeFS.existsSync(source)) {
  console.error(`stage-install-script: ${source} is missing; the site cannot serve /install.sh`);
  process.exit(1);
}
NodeFS.mkdirSync(publicDir, { recursive: true });
NodeFS.copyFileSync(source, NodePath.join(publicDir, "install.sh"));
