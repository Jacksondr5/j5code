import * as NodeFS from "node:fs";

for (const file of ["research-review.yaml", "fh/development.yaml"]) {
  const target = new URL(`../dist/${file}`, import.meta.url);
  NodeFS.mkdirSync(new URL("./", target), { recursive: true });
  NodeFS.copyFileSync(new URL(`../src/j5/playbook-definitions/${file}`, import.meta.url), target);
}
