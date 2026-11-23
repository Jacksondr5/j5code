const STORAGE_KEY = "j5:sidebar:spawned-children:expanded";

export const readExpandedSpawnParents = (
  storage: Pick<Storage, "getItem"> | undefined,
): ReadonlySet<string> => {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null || raw === undefined ? [] : JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
};

export const writeExpandedSpawnParents = (
  storage: Pick<Storage, "setItem"> | undefined,
  expanded: ReadonlySet<string>,
) => {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // Storage may be unavailable (private mode, quota); expansion then lasts for the session.
  }
};
