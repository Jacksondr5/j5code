/**
 * Sidebar membership (register D22): human-created agents show; agent-spawned Peer Agents (Crew
 * members included) appear under their spawner unless the user pinned them. `spawnedByAgent` is
 * the spawned-children read's statement of placement provenance. A row the read has not answered
 * for shows, never guesses.
 */
export const isSidebarMember = (
  thread: { readonly pinnedAt?: string | null | undefined },
  spawnedByAgent: boolean,
) => !(spawnedByAgent && thread.pinnedAt == null);

/** The thread as a top-level sidebar row, or undefined when it lists under its spawner. */
export const sidebarRowThread = <T extends { readonly pinnedAt?: string | null | undefined }>(
  thread: T | undefined,
  spawnedByAgent: boolean,
): T | undefined =>
  thread !== undefined && isSidebarMember(thread, spawnedByAgent) ? thread : undefined;
