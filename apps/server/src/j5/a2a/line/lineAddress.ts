/**
 * A line address: where this server's link to a peer that polls it is made. The host is on this
 * server's own loopback in 127.77.0.0/16 and nothing listens there; the line HTTP client sends any
 * request for it through the peer's line instead. Port 1 has no listener either, so a request that
 * missed that client is refused rather than reaching a real service here.
 */
const LINE_HOST_PREFIX = "127.77.";
const LINE_PORT = 1;
const MAX_SLOT = 0xffff;

/** Null for a slot past the 65,535 the range holds: that poller holds no line, and reads still work. */
export const lineAddressForSlot = (slot: number): string | null =>
  Number.isSafeInteger(slot) && slot >= 1 && slot <= MAX_SLOT
    ? `http://${LINE_HOST_PREFIX}${String(slot >> 8)}.${String(slot & 0xff)}:${String(LINE_PORT)}`
    : null;

/** Whether a URL's hostname is a line host; such a request may only travel through a line. */
export const isLineHost = (hostname: string): boolean => {
  if (!hostname.startsWith(LINE_HOST_PREFIX)) return false;
  const rest = hostname.slice(LINE_HOST_PREFIX.length).split(".");
  return rest.length === 2 && rest.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};
