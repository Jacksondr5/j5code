/**
 * Highlights: the short "What's new" entries a client shows once after it has a build with a
 * substantial new feature. An entry is committed with its feature's PR; whether a feature
 * deserves one is decided in that PR's review. Seen-tracking is per client, so this module is pure:
 * each client passes in what it has stored.
 */

export type HighlightClient = "web" | "desktop" | "mobile";

/** Names an illustration each client draws for itself; an entry without one is a plain text row. */
export type HighlightArt = "peering";

export interface Highlight {
  /** Stable for the life of the entry: the seen record stores it. */
  readonly id: string;
  readonly title: string;
  /** One or two lines. */
  readonly description: string;
  /** A page on the marketing site, live before the build that links to it ships. */
  readonly learnMoreUrl?: string;
  readonly art?: HighlightArt;
  readonly clients: ReadonlyArray<HighlightClient>;
}

/** Newest first. Add an entry at the top. */
export const HIGHLIGHTS: ReadonlyArray<Highlight> = [
  {
    id: "2026-11-release-0-0-52-links",
    title: "Your agents can work across machines",
    description:
      "Link two J5 servers and your agents can message agents on the other one, hand them tasks, and use its tools at the access you choose, even when it's a laptop behind a firewall. One link sets it all up.",
    learnMoreUrl: "https://j5.codes/linking",
    art: "peering",
    clients: ["web", "desktop"],
  },
  {
    id: "2026-11-release-0-0-52-crews-personas",
    title: "Crews and personas need you less",
    description:
      "Crews can start on their own when you allow it, and a Captain's chat shows only what needs you. A persona an agent picks never gets more access than that agent has; when one is blocked, you can allow it once.",
    learnMoreUrl: "https://j5.codes/whats-new/0-0-52#crews",
    clients: ["web", "desktop"],
  },
  {
    id: "2026-11-release-0-0-52-also-new",
    title: "Also new",
    description:
      "Windows app in beta. Side chats with /side. A refreshed design. An improved Inbox. And much more.",
    learnMoreUrl: "https://j5.codes/whats-new/0-0-52",
    clients: ["web", "desktop"],
  },
];

export const highlightsForClient = (
  entries: ReadonlyArray<Highlight>,
  client: HighlightClient,
): ReadonlyArray<Highlight> => entries.filter((entry) => entry.clients.includes(client));

/**
 * What the client shows as new. First run writes a record of every entry as seen before it marks
 * itself finished, so a finished client with no record is an existing one meeting highlights for
 * the first time, and sees everything. An unfinished first run shows nothing.
 */
export function unseenHighlights(input: {
  readonly entries: ReadonlyArray<Highlight>;
  readonly seen: ReadonlyArray<string> | null;
  readonly firstRunComplete: boolean;
}): ReadonlyArray<Highlight> {
  if (!input.firstRunComplete) return [];
  if (input.seen === null) return input.entries;
  const seen = new Set(input.seen);
  return input.entries.filter((entry) => !seen.has(entry.id));
}

/**
 * The record after dismissing one entry. A client with no record yet starts from nothing, since
 * it was showing every entry.
 */
export const withHighlightSeen = (
  seen: ReadonlyArray<string> | null,
  id: string,
): ReadonlyArray<string> => (seen === null ? [id] : seen.includes(id) ? seen : [...seen, id]);
