import { J5_IDENTITY_DESCRIBE_PATH, type J5AppLinkScheme } from "@t3tools/contracts/j5";
import { LogInIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

import {
  PairingPendingSurface,
  PairingRouteSurface,
} from "../../components/auth/PairingRouteSurface";
import { Button } from "../../components/ui/button";
import { StandalonePage, StandalonePageHeader } from "../../components/ui/standalone-page";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";
import { DESCRIBE_TIMEOUT_MS } from "./joinPage.logic";
import {
  SIGN_IN_OUTCOME_WORDS,
  appSignInRetryOf,
  signInAppOf,
  signInHost,
  signInOutcomeOf,
  signInUrl,
} from "./signIn.logic";

async function describeSignIn(): Promise<string | null> {
  try {
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl(J5_IDENTITY_DESCRIBE_PATH), {
      signal: AbortSignal.timeout(DESCRIBE_TIMEOUT_MS),
      credentials: "include",
    });
    return response.ok ? signInHost(await response.json()) : null;
  } catch {
    return null;
  }
}

/** The J5 Connect host the server signs in through; `undefined` until it answers. */
function useSignInHost() {
  const [host, setHost] = useState<string | null | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server once whether it offers sign-in.
  useEffect(() => {
    let cancelled = false;
    void describeSignIn().then((answer) => {
      if (!cancelled) setHost(answer);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return host;
}

/** Signing in, or what the last try came back with; a sign-in an app started goes back to it. */
function SignInCard({
  host,
  app,
  children,
}: {
  readonly host: string | null;
  readonly app: J5AppLinkScheme | null;
  readonly children?: ReactNode;
}) {
  const [outcome] = useState(() => signInOutcomeOf(window.location.href));
  const words = outcome === null ? null : SIGN_IN_OUTCOME_WORDS[outcome];
  return (
    <StandalonePage>
      <StandalonePageHeader
        title={words?.title ?? "Sign in to this server"}
        description={
          words?.description ??
          "Sign in with your account at J5 Connect. If this server doesn't know you yet, its Owners are asked to let you in."
        }
      />
      {app === null ? null : (
        <p className="mt-3 text-sm text-muted-foreground">
          {host === null
            ? "You started this from the J5 Code app. Go back to it."
            : "You started this from the J5 Code app. Signing in again here takes you back to it."}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        {host === null ? null : (
          <Button
            size="sm"
            render={<a href={signInUrl(resolvePrimaryEnvironmentHttpUrl("/"), app)} />}
          >
            <LogInIcon />
            {outcome === null ? `Sign in with ${host}` : `Sign in again with ${host}`}
          </Button>
        )}
        {children}
      </div>
    </StandalonePage>
  );
}

/**
 * The pairing page with no link in it, on a server that trusts a J5 Connect: sign in, or pair with
 * a token as before. After a sign-in that did not pair, says why. A server that trusts none gets
 * upstream's page alone.
 */
export function SignInPairing(props: ComponentProps<typeof PairingRouteSurface>) {
  const host = useSignInHost();
  const [app] = useState(() => signInAppOf(window.location.href));
  const [withToken, setWithToken] = useState(false);

  if (host === undefined) return <PairingPendingSurface />;
  if (host === null) return <PairingRouteSurface {...props} />;
  if (withToken) {
    // Upstream's card scrolls in its own space, with the way back to sign-in below it.
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="min-h-0 flex-1">
          <PairingRouteSurface {...props} />
        </div>
        <div className="flex justify-center px-4 pb-6">
          <Button size="sm" variant="outline" onClick={() => setWithToken(false)}>
            <LogInIcon />
            Sign in with {host} instead
          </Button>
        </div>
      </div>
    );
  }
  return (
    <SignInCard host={host} app={app}>
      {app === null ? (
        <Button size="sm" variant="outline" onClick={() => setWithToken(true)}>
          Use a pairing token
        </Button>
      ) : null}
    </SignInCard>
  );
}

/** Whether `/pair` is an app's sign-in coming back, shown even to a browser paired here. */
export const isAppSignInRetry = (href: string) => appSignInRetryOf(href) !== null;

/** An app's sign-in that came back without pairing, in a browser that may be paired already. */
export function AppSignInRetry() {
  const host = useSignInHost();
  const [retry] = useState(() => appSignInRetryOf(window.location.href));
  if (host === undefined) return <PairingPendingSurface />;
  return <SignInCard host={host} app={retry?.app ?? null} />;
}
