/** Command that runs the agent-skills terminal wizard on the environment's machine. */
export function skillInstallerCommand(
  folder: string,
  platform: string | null | undefined,
): string | null {
  const trimmed = folder.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const script = `${trimmed}/install-skills.mjs`;
  const quoted =
    platform === "windows"
      ? `"${script.replace(/"/g, '""')}"`
      : `'${script.replace(/'/g, `'\\''`)}'`;
  return `node ${quoted}`;
}
