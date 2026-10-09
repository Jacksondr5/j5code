import { PLAYBOOK_MAX_BYTES, suggestPlaybookName } from "@t3tools/contracts/j5";

/**
 * Maps a picked file name to its playbook name, without directories or the YAML extension.
 * The stem becomes a valid name, so "Release Plan.yaml" imports as `release-plan`.
 */
export function playbookImportName(fileName: string, size: number): string {
  const basename = fileName.split(/[/\\]/).pop() ?? "";
  if (!/\.ya?ml$/i.test(basename)) {
    throw new Error(`Cannot import "${fileName}": choose a .yaml or .yml file.`);
  }
  const name = suggestPlaybookName(basename.replace(/\.ya?ml$/i, ""));
  if (!name) {
    throw new Error(`Cannot import "${fileName}": its name needs at least one letter or digit.`);
  }
  if (size > PLAYBOOK_MAX_BYTES) {
    throw new Error(
      `Cannot import "${fileName}": YAML files must be no larger than ${PLAYBOOK_MAX_BYTES / 1024} KiB.`,
    );
  }
  return name;
}
