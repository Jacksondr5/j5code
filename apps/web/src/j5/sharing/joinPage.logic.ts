import type { SharingLinkDescription, SharingLinkOpens } from "@t3tools/contracts/j5";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// A thread is named with its project after it; only the thing itself is set in bold.
const named = (opens: SharingLinkOpens) =>
  opens.kind === "project"
    ? { title: opens.projectTitle, inProject: "" }
    : {
        title: opens.threadTitle,
        inProject: opens.projectTitle === null ? "" : ` in ${opens.projectTitle}`,
      };

/** What a person is being invited to, as the join page says it. `title` is the part shown in bold. */
export interface Invitation {
  readonly before: string;
  readonly title: string | null;
  readonly after: string;
}

export function invitationFor(description: SharingLinkDescription): Invitation {
  const { opens, serverName } = description;
  const on = serverName === "" ? "" : ` on ${serverName}`;
  if (description.kind === "open") {
    const thread = opens[0] === undefined ? { title: "a thread", inProject: "" } : named(opens[0]);
    return {
      before: "You have been invited to ",
      title: thread.title,
      after: `${thread.inProject}${on}. You can read it and watch the agent work; you cannot send it anything.`,
    };
  }
  if (opens.length === 0) {
    return {
      before: `Nothing is shared with you${on} yet. Once you join, a member can share a thread or project with you and it will appear on its own.`,
      title: null,
      after: "",
    };
  }
  if (opens.length === 1) {
    const only = named(opens[0]!);
    return {
      before: "You have been invited to ",
      title: only.title,
      after: `${only.inProject}${on}.`,
    };
  }
  const threads = opens.filter((item) => item.kind === "thread").length;
  const projects = opens.length - threads;
  const parts = [
    ...(threads > 0 ? [count(threads, "thread", "threads")] : []),
    ...(projects > 0 ? [count(projects, "project", "projects")] : []),
  ];
  return {
    before: `You have been invited to ${parts.join(" and ")}${on}.`,
    title: null,
    after: "",
  };
}

/** The most lines the join page lists before it says how many more there are. */
export const MOST_LISTED = 5;

/** One line of the join page's list: a title, its project when it is a thread, and its icon. */
export interface InvitationLine {
  readonly title: string;
  readonly detail: string | null;
  readonly icon: SharingLinkOpens["projectIcon"];
  /** A signed link to the project's favicon, relative to the server; drawn when no icon was chosen. */
  readonly faviconUrl: string | null;
}

/** The short list under the invitation when a link opens several things. */
export function invitationList(description: SharingLinkDescription): {
  readonly lines: ReadonlyArray<InvitationLine>;
  readonly more: number;
} {
  if (description.kind !== "person" || description.opens.length < 2) return { lines: [], more: 0 };
  return {
    lines: description.opens.slice(0, MOST_LISTED).map((item) => ({
      title: item.kind === "project" ? item.projectTitle : item.threadTitle,
      detail: item.kind === "project" ? null : item.projectTitle,
      // An older server sends neither; the line then falls back to the default icon.
      icon: item.projectIcon ?? null,
      faviconUrl: item.projectFaviconUrl ?? null,
    })),
    more: Math.max(0, description.opens.length - MOST_LISTED),
  };
}

/** What the page shows for a link before anything is spent. */
export type JoinPageState =
  /** Not a guest's link, or nothing can be said of it: upstream's pairing page takes it. */
  | { readonly kind: "upstream" }
  | { readonly kind: "dead" }
  | { readonly kind: "described"; readonly description: SharingLinkDescription };

/**
 * Reads the lookup's answer. A link the server describes gets the guest's page whether or not it
 * carries J5's mark, so one made by an older build or typed by hand still works. The server gives
 * one refusal for every link it will not describe, an ordinary pairing link among them, so only
 * the mark says that an undescribed link was a share link, and so one that no longer works.
 */
export function joinPageState(input: {
  readonly marked: boolean;
  readonly status: number | null;
  readonly body: unknown;
}): JoinPageState {
  if (input.status === 200 && isDescription(input.body)) {
    return { kind: "described", description: input.body };
  }
  if (input.status === 404 && input.marked) return { kind: "dead" };
  return { kind: "upstream" };
}

/**
 * What the first screen does while the server has or has not yet said which kind the connection
 * is. A member is never kept waiting: upstream's landing is drawn at once unless this browser was
 * paired through a share link, in which case the frame is held so a guest is not first dropped
 * into a draft they cannot send.
 */
export function landingFor(input: {
  readonly kind: "member" | "guest" | null;
  readonly pairedThroughShareLink: boolean;
}): "upstream" | "hold" | "guest" {
  if (input.kind === "guest") return "guest";
  if (input.kind === "member") return "upstream";
  return input.pairedThroughShareLink ? "hold" : "upstream";
}

function isDescription(body: unknown): body is SharingLinkDescription {
  if (typeof body !== "object" || body === null) return false;
  const value = body as Partial<SharingLinkDescription>;
  return (
    (value.kind === "person" || value.kind === "open") &&
    typeof value.serverName === "string" &&
    Array.isArray(value.opens)
  );
}
