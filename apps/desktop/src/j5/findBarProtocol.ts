/** The find bar page to the main process. */
export const FIND_BAR_COMMAND_CHANNEL = "j5:find-bar-command";
/** The main process to the find bar page: focus the field and select its text. */
export const FIND_BAR_FOCUS_CHANNEL = "j5:find-bar-focus";
/** The main process to the find bar page: the match count, or null to clear it. */
export const FIND_BAR_MATCHES_CHANNEL = "j5:find-bar-matches";

export type FindBarCommand =
  | { readonly type: "query"; readonly text: string }
  | { readonly type: "next" }
  | { readonly type: "previous" }
  | { readonly type: "close" };

export interface FindMatches {
  readonly active: number;
  readonly total: number;
}
