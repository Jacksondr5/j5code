import { describe, expect, it } from "vite-plus/test";

import {
  isPeerCredentialRejected,
  peerCredentialRejectedReason,
  peerPollState,
  peerPollStoppedError,
  peerPollStoppedReason,
} from "./peerPoll.ts";

describe("peerPollState", () => {
  it("is online while it polled in the last two minutes, and offline since the last poll after that", () => {
    const now = Date.parse("2026-10-02T12:10:00.000Z");
    expect(peerPollState({ linkMode: "push", lastPolledAt: null }, now)).toBeNull();
    expect(peerPollState({ linkMode: "store", lastPolledAt: null }, now)).toEqual({
      kind: "never",
    });
    expect(
      peerPollState({ linkMode: "store", lastPolledAt: "2026-10-02T12:08:30.000Z" }, now),
    ).toEqual({ kind: "online", lastPolledAt: "2026-10-02T12:08:30.000Z" });
    expect(
      peerPollState({ linkMode: "poll", lastPolledAt: "2026-10-02T12:07:00.000Z" }, now),
    ).toEqual({ kind: "offline", since: "2026-10-02T12:07:00.000Z" });
  });
});

describe("isPeerCredentialRejected", () => {
  it("is true only when the poller stopped on a rejected credential", () => {
    const rejected = peerCredentialRejectedReason("Work VM");
    const poller = (lastError: string | null) => ({ linkMode: "poll", lastError }) as const;
    expect(isPeerCredentialRejected(poller(peerPollStoppedError(rejected)))).toBe(true);
    // A retried failure quoting the same words did not stop polling.
    expect(isPeerCredentialRejected(poller(rejected))).toBe(false);
    expect(
      isPeerCredentialRejected(poller(`Work VM answered the poll with HTTP 502: ${rejected}`)),
    ).toBe(false);
    expect(
      isPeerCredentialRejected(
        poller(
          peerPollStoppedError(
            "Work VM runs peer protocol 3 and this server runs 2. Update J5 on this server, then try again.",
          ),
        ),
      ),
    ).toBe(false);
    expect(
      isPeerCredentialRejected({ linkMode: "store", lastError: peerPollStoppedError(rejected) }),
    ).toBe(false);
    expect(isPeerCredentialRejected(poller(null))).toBe(false);
  });

  it("is true for a server that sends directly once it recorded the rejection", () => {
    const rejected = peerCredentialRejectedReason("Work VM");
    expect(isPeerCredentialRejected({ linkMode: "push", lastError: rejected })).toBe(true);
    expect(isPeerCredentialRejected({ linkMode: "push", lastError: null })).toBe(false);
    expect(
      isPeerCredentialRejected({
        linkMode: "push",
        lastError:
          "Work VM runs peer protocol 3 and this server runs 2. Update J5 on this server, then try again.",
      }),
    ).toBe(false);
  });
});

describe("peerPollStoppedReason", () => {
  it("reads only what the poller recorded when it stopped", () => {
    const poller = (lastError: string | null) => ({ linkMode: "poll", lastError }) as const;
    const rejected = peerCredentialRejectedReason("Work VM");
    expect(peerPollStoppedReason(poller(peerPollStoppedError(rejected)))).toBe(rejected);
    // A failure the poller retries is never a stop, however it is worded.
    expect(
      peerPollStoppedReason(
        poller("Work VM answered the poll with HTTP 502: Server busy, then try again."),
      ),
    ).toBeNull();
    expect(peerPollStoppedReason(poller(rejected)), "only the poller's own mark counts").toBeNull();
    // Only a poller stops polling.
    expect(
      peerPollStoppedReason({ linkMode: "push", lastError: peerPollStoppedError(rejected) }),
    ).toBeNull();
    expect(peerPollStoppedReason(poller(null))).toBeNull();
  });
});
