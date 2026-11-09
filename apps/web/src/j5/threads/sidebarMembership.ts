import { isSidebarMember } from "@t3tools/client-runtime/j5/spawned-children";

export { isSidebarMember };

/** The thread as a top-level sidebar row, or undefined when it lists under its spawner. */
export const sidebarRowThread = <T extends { readonly pinnedAt?: string | null | undefined }>(
  thread: T | undefined,
  spawnedByAgent: boolean,
): T | undefined =>
  thread !== undefined && isSidebarMember(thread, spawnedByAgent) ? thread : undefined;
