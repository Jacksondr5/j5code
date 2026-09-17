import { PeerOrigin } from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";

/**
 * The client's side of peering: it is the one party connected to both servers,
 * so it introduces them. Each server ends up holding the credential the other
 * issued and the origin it reaches the other at. Nothing here talks to a
 * server; the caller supplies the two verbs and this sequences them.
 */

/** One server in an introduction. `origin` is where the *other* server reaches this one. */
export interface PeeringSide {
  readonly environmentId: string;
  readonly label: string;
  readonly origin: string;
}

export type PeeringStep = "issue-local" | "issue-remote" | "record-remote" | "record-local";

export interface PeeringStepOutcome {
  readonly step: PeeringStep;
  readonly status: "done" | "failed" | "skipped";
  readonly detail: string | null;
}

export interface PeeringOutcome {
  readonly ok: boolean;
  readonly steps: ReadonlyArray<PeeringStepOutcome>;
}

const PEERING_STEPS: ReadonlyArray<PeeringStep> = [
  "issue-local",
  "issue-remote",
  "record-remote",
  "record-local",
];

export const peeringStepTitle = (step: PeeringStep, local: PeeringSide, remote: PeeringSide) => {
  switch (step) {
    case "issue-local":
      return `Issue a credential on ${local.label} for ${remote.label}`;
    case "issue-remote":
      return `Issue a credential on ${remote.label} for ${local.label}`;
    case "record-remote":
      return `Record ${remote.label} on ${local.label}`;
    case "record-local":
      return `Record ${local.label} on ${remote.label}`;
  }
};

const isPeerOrigin = Schema.is(PeerOrigin);

/** The origin the client uses is only a hint; a trailing slash is the one thing safe to fix. */
export const defaultPeerOrigin = (httpBaseUrl: string | null): string =>
  httpBaseUrl === null ? "" : httpBaseUrl.replace(/\/+$/, "");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** Names the trap the definition warns about: an address that works for this client but not between servers. */
export const peerOriginWarning = (origin: string): string | null => {
  if (origin.trim().length === 0) return null;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname)
      ? "This is a loopback address. It works for this client, but the other server cannot reach it; use the address that server can reach."
      : null;
  } catch {
    return null;
  }
};

export type PeeringReadiness =
  | { readonly kind: "missing-environment"; readonly message: string }
  | { readonly kind: "environment-disconnected"; readonly message: string }
  | { readonly kind: "read-only-environment"; readonly message: string }
  | { readonly kind: "invalid-origin"; readonly message: string }
  | { readonly kind: "ready" };

export const resolvePeeringReadiness = (input: {
  readonly otherLabel: string | null;
  readonly otherConnected: boolean;
  readonly otherCanManage: boolean;
  readonly localOrigin: string;
  readonly remoteOrigin: string;
}): PeeringReadiness => {
  if (input.otherLabel === null) {
    return { kind: "missing-environment", message: "Choose the environment to peer with." };
  }
  if (!input.otherConnected) {
    return {
      kind: "environment-disconnected",
      message: `Connect to ${input.otherLabel} first; peering needs both servers reachable from this client.`,
    };
  }
  if (!input.otherCanManage) {
    return {
      kind: "read-only-environment",
      message: `This connection to ${input.otherLabel} cannot manage access (it lacks access:write), so it cannot issue a peer credential there.`,
    };
  }
  if (!isPeerOrigin(input.localOrigin) || !isPeerOrigin(input.remoteOrigin)) {
    return {
      kind: "invalid-origin",
      message:
        "Each origin must be an http(s) address with no path, such as https://home.example:3773.",
    };
  }
  return { kind: "ready" };
};

const detailOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

/**
 * Mutual, in one act: each server issues a credential for the other, then each
 * records the other after proving that credential at the origin. Stops at the
 * first failure and reports every step, so the person sees exactly what stands.
 */
export async function introducePeers(input: {
  readonly local: PeeringSide;
  readonly remote: PeeringSide;
  /** On `issuer`, mint the credential `holder` will present when it delivers to `issuer`. */
  readonly issue: (issuer: PeeringSide, holder: PeeringSide) => Promise<{ credential: string }>;
  /** On `recorder`, record `peer` at `peer.origin`, proving `credential` (the one `peer` issued to `recorder`). */
  readonly record: (
    recorder: PeeringSide,
    peer: PeeringSide,
    credential: string,
  ) => Promise<unknown>;
}): Promise<PeeringOutcome> {
  const steps: Array<PeeringStepOutcome> = [];
  const run = async (step: PeeringStep, action: () => Promise<unknown>) => {
    try {
      const result = await action();
      steps.push({ step, status: "done", detail: null });
      return result;
    } catch (cause) {
      steps.push({ step, status: "failed", detail: detailOf(cause) });
      throw cause;
    }
  };
  try {
    const forRemote = (await run("issue-local", () => input.issue(input.local, input.remote))) as {
      credential: string;
    };
    const forLocal = (await run("issue-remote", () => input.issue(input.remote, input.local))) as {
      credential: string;
    };
    await run("record-remote", () => input.record(input.local, input.remote, forLocal.credential));
    await run("record-local", () => input.record(input.remote, input.local, forRemote.credential));
    return { ok: true, steps };
  } catch {
    for (const step of PEERING_STEPS) {
      if (!steps.some((outcome) => outcome.step === step)) {
        steps.push({ step, status: "skipped", detail: null });
      }
    }
    return { ok: false, steps };
  }
}
