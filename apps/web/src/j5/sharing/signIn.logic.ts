import {
  IdentityDescription,
  J5_IDENTITY_SIGN_IN_PATH,
  J5_SIGN_IN_APP_PARAM,
  J5_SIGN_IN_OUTCOME_PARAM,
  type J5AppLinkScheme,
  SignInOutcome,
  isJ5AppLinkScheme,
} from "@t3tools/contracts/j5";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
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
 * The app a sign-in was started from, named on the pairing page's address after it came back
 * without pairing, so the next try goes back to the app too; `null` for a browser's own.
 */
export function signInAppOf(href: string): J5AppLinkScheme | null {
  const value = new URL(href).searchParams.get(J5_SIGN_IN_APP_PARAM);
  return isJ5AppLinkScheme(value) ? value : null;
}

/**
 * Where a browser or app starts signing in at a server. An app passes its own link scheme, so a
 * sign-in that pairs comes back to it.
 */
export function signInUrl(serverBase: string, appScheme: J5AppLinkScheme | null = null): string {
  const url = new URL(J5_IDENTITY_SIGN_IN_PATH, serverBase);
  if (appScheme !== null) url.searchParams.set(J5_SIGN_IN_APP_PARAM, appScheme);
  return url.toString();
}

/**
 * The desktop app's own link scheme, read from the address its window is served from
 * (`j5code://app/`, `j5code-dev://app/`); `null` outside the desktop app.
 */
export function desktopAppScheme(protocol: string): J5AppLinkScheme | null {
  const scheme = protocol.endsWith(":") ? protocol.slice(0, -1) : protocol;
  return isJ5AppLinkScheme(scheme) ? scheme : null;
}

const LOOPBACK_OR_IP = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i;

/**
 * A server's address from what a person typed into Add environment: upstream's own reading of a
 * host, which takes a name to HTTPS, except that this machine and an IP address stay plain HTTP,
 * as on a local network. `null` for nothing usable.
 */
export function serverBaseFromHost(typed: string): string | null {
  const host = typed.trim();
  if (host === "") return null;
  try {
    const written = LOOPBACK_OR_IP.test(host) ? `http://${host}` : host;
    // The code is never sent: only the address upstream reads from the host is kept.
    return new URL(
      resolveRemotePairingTarget({ host: written, pairingCode: "sign-in" }).httpBaseUrl,
    ).origin;
  } catch {
    return null;
  }
}

const httpOrigin = (address: string): string | null => {
  try {
    const url = new URL(address);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
};

/** Routes whose address is the server's own; an SSH tunnel's or a relay's is not. */
const DIRECT_ROUTES = new Set(["PrimaryConnectionTarget", "BearerConnectionTarget"]);

/**
 * The address a server joining J5 Connect is offered as one people reach it at: the page's own
 * when that server serves the page, otherwise the address this client reaches it at directly.
 */
export function joinAddresses(input: {
  readonly servesPage: boolean;
  readonly pageHref: string;
  readonly reachedAt: { readonly route: string; readonly httpBaseUrl: string } | null;
}): ReadonlyArray<string> {
  const address = input.servesPage
    ? httpOrigin(input.pageHref)
    : input.reachedAt === null || !DIRECT_ROUTES.has(input.reachedAt.route)
      ? null
      : httpOrigin(input.reachedAt.httpBaseUrl);
  return address === null ? [] : [address];
}

/**
 * A sign-in an app started that came back without pairing, from the pairing page's address. A
 * browser already paired here still shows it, so the next try can go back to the app.
 */
export function appSignInRetryOf(
  href: string,
): { readonly outcome: SignInOutcome; readonly app: J5AppLinkScheme } | null {
  const outcome = signInOutcomeOf(href);
  const app = signInAppOf(href);
  return outcome === null || app === null ? null : { outcome, app };
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
