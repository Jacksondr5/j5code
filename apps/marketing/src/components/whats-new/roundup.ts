/** The T3 Code versions the roundup covers, and its entries for a page's contents list. */
export const UPSTREAM_RANGE = "0.1.8 to 0.1.11";

interface ContentsEntry {
  href: string;
  title: string;
  line: string;
  /** Whose work the entry is: J5 Code's own, or taken in from T3 Code. */
  origin: "j5" | "t3";
}

export const ROUNDUP_CONTENTS: ReadonlyArray<ContentsEntry> = [
  { href: "#issues", title: "Issues", line: "Five trackers, beside your threads.", origin: "t3" },
  {
    href: "#pull-requests",
    title: "Agents on pull requests and CI",
    // The word joiner keeps "re-run" on one line.
    line: "Open, review, merge a stack, read failing logs, re-⁠run checks.",
    origin: "t3",
  },
  {
    href: "#sessions",
    title: "Fresh sessions you can see",
    line: "/clear, and a divider wherever a session starts over.",
    origin: "t3",
  },
  {
    href: "#welcome",
    title: "One Welcome page",
    line: "First run on a single page.",
    origin: "t3",
  },
  {
    href: "#servers",
    title: "Dev servers from other machines",
    line: "Opened here, with the port forwarded.",
    origin: "t3",
  },
  {
    href: "#voice",
    title: "Voice dictation",
    line: "On a server, in the cloud, or on the phone.",
    origin: "t3",
  },
  {
    href: "#upkeep",
    title: "Awake, and a lighter database",
    line: "Keep the computer awake. Reclaim freed space from Settings.",
    origin: "t3",
  },
  {
    href: "#mobile",
    title: "On the phone and tablet",
    line: "Cite an agent's text. A layout for every size.",
    origin: "t3",
  },
  {
    href: "#j5",
    title: "Steering and links",
    line: "Two changes on J5 Code's side.",
    origin: "j5",
  },
];
