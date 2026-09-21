export const PLAYBOOK_IMPORT_MAX_BYTES = 262144;
const namePattern = /^[^/\\\p{Cc}]+$/u;

/** Maps a picked file name to its playbook name, without directories or the YAML extension. */
export function playbookImportName(fileName: string, size: number): string {
  const basename = fileName.split(/[/\\]/).pop() ?? "";
  if (!/\.ya?ml$/i.test(basename)) {
    throw new Error(`Cannot import "${fileName}": choose a .yaml or .yml file.`);
  }
  const name = basename.replace(/\.ya?ml$/i, "");
  if (!namePattern.test(name)) {
    throw new Error(
      `Cannot import "${fileName}": use a non-empty name without control characters.`,
    );
  }
  if (size > PLAYBOOK_IMPORT_MAX_BYTES) {
    throw new Error(`Cannot import "${fileName}": YAML files must be no larger than 256 KiB.`);
  }
  return name;
}
