import {
  IdentityDescription,
  J5_IDENTITY_SIGN_IN_PATH,
  J5_SIGN_IN_APP_PARAM,
  J5_SIGN_IN_OUTCOME_PARAM,
  SignInOutcome,
} from "@t3tools/contracts/j5";
import * as Schema from "effect/Schema";

const decodeDescription = Schema.decodeUnknownOption(IdentityDescription);
const isOutcome = Schema.is(SignInOutcome);

/** The J5 Connect host to name on the button, or `null` when the server offers no sign-in. */
export function signInHost(body: unknown): string | null {
  const description = decodeDescription(body);
  return description._tag === "Some" ? (description.value.signIn?.host ?? null) : null;
}

/** What the J5 Connect's return said, from the pairing page's address; `null` for none. */
export function signInOutcomeOf(href: string): SignInOutcome | null {
  const value = new URL(href).searchParams.get(J5_SIGN_IN_OUTCOME_PARAM);
  return isOutcome(value) ? value : null;
}

/**
 * Where a browser or app starts signing in at a server. An app passes its own link scheme, so a
 * sign-in that pairs comes back to it.
 */
export function signInUrl(serverBase: string, appScheme: string | null = null): string {
  const url = new URL(J5_IDENTITY_SIGN_IN_PATH, serverBase);
  if (appScheme !== null) url.searchParams.set(J5_SIGN_IN_APP_PARAM, appScheme);
  return url.toString();
}

/**
 * The desktop app's own link scheme, read from the address its window is served from
 * (`j5code://app/`, `j5code-dev://app/`); `null` outside the desktop app.
 */
export function desktopAppScheme(protocol: string): string | null {
  return /^j5code(?:-[a-z]+)?:$/.test(protocol) ? protocol.slice(0, -1) : null;
}

/**
 * A server's address from what a person typed: as given with its scheme, plain HTTP for this
 * machine, an IP address or an address with a port, and HTTPS for a name. `null` for nothing usable.
 */
export function serverBaseFromHost(typed: string): string | null {
  const host = typed.trim();
  if (host === "") return null;
  const plain =
    /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(host) || /:\d+$/.test(host);
  try {
    const url = new URL(
      /^https?:\/\//i.test(host) ? host : `${plain ? "http" : "https"}://${host}`,
    );
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export const SIGN_IN_OUTCOME_WORDS: Record<
  SignInOutcome,
  { readonly title: string; readonly description: string }
> = {
  waiting: {
    title: "Waiting for an Owner",
    description:
      "You're signed in, but this server doesn't know you yet. Its Owners have been asked to let you in. Sign in again once one of them has.",
  },
  "not-let-in": {
    title: "Not let in",
    description:
      "This account isn't let in to this server. Ask one of its Owners, or open a link they send you.",
  },
  failed: {
    title: "Sign-in didn't finish",
    description: "Something went wrong between this server and J5 Connect. Try again.",
  },
};
