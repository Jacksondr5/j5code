import { PLAYBOOK_MAX_BYTES, PLAYBOOK_NAME_PATTERN } from "@t3tools/contracts/j5";

/** Maps a picked file name to its playbook name, without directories or the YAML extension. */
export function playbookImportName(fileName: string, size: number): string {
  const basename = fileName.split(/[/\\]/).pop() ?? "";
  if (!/\.ya?ml$/i.test(basename)) {
    throw new Error(`Cannot import "${fileName}": choose a .yaml or .yml file.`);
  }
  const name = basename.replace(/\.ya?ml$/i, "");
  if (!PLAYBOOK_NAME_PATTERN.test(name)) {
    throw new Error(
      `Cannot import "${fileName}": use a non-empty name without control characters.`,
    );
  }
  if (size > PLAYBOOK_MAX_BYTES) {
    throw new Error(
      `Cannot import "${fileName}": YAML files must be no larger than ${PLAYBOOK_MAX_BYTES / 1024} KiB.`,
    );
  }
  return name;
}
