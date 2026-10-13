// Whether this browser was last paired to its server through a share link. It is one flag in the
// browser's own storage, which is already per server: a browser reaches one server per origin.
// It decides nothing about access. It only lets the first screen wait for the server to say the
// connection is a guest's, instead of starting a draft a guest could not send.
const KEY = "j5:sharing:paired-through-share-link";

export function wasPairedThroughShareLink(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function rememberPairedThroughShareLink(paired: boolean): void {
  try {
    if (paired) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage that cannot be written costs a guest one draft screen, which the server refuses.
  }
}
