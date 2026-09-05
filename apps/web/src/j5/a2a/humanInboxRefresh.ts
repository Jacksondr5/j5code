export const HUMAN_INBOX_REFRESH_EVENT = "j5:human-inbox-refresh";

export function notifyHumanInboxChanged() {
  window.dispatchEvent(new Event(HUMAN_INBOX_REFRESH_EVENT));
}
