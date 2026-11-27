import { J5_IDENTITY_DESCRIBE_PATH } from "@t3tools/contracts/j5";
import { LogInIcon } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";

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

/**
 * The pairing page with no link in it, on a server that trusts a J5 Connect: sign in, or pair with
 * a token as before. After a sign-in that did not pair, says why. A server that trusts none gets
 * upstream's page alone.
 */
export function SignInPairing(props: ComponentProps<typeof PairingRouteSurface>) {
  const [host, setHost] = useState<string | null | undefined>(undefined);
  const [outcome] = useState(() => signInOutcomeOf(window.location.href));
  // A sign-in the desktop or mobile app started keeps going back to that app on each try.
  const [app] = useState(() => signInAppOf(window.location.href));
  const [withToken, setWithToken] = useState(false);

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

  if (host === undefined) return <PairingPendingSurface />;
  if (host === null) return <PairingRouteSurface {...props} />;
  if (withToken) {
    // Upstream's form takes the whole page; the way back to sign-in sits beneath it.
    return (
      <>
        <PairingRouteSurface {...props} />
        <div className="fixed inset-x-0 bottom-6 flex justify-center">
          <Button size="sm" variant="outline" onClick={() => setWithToken(false)}>
            <LogInIcon />
            Sign in with {host} instead
          </Button>
        </div>
      </>
    );
  }

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
          You started this from the J5 Code app. Signing in again here takes you back to it.
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button
          size="sm"
          render={<a href={signInUrl(resolvePrimaryEnvironmentHttpUrl("/"), app)} />}
        >
          <LogInIcon />
          {outcome === null ? `Sign in with ${host}` : `Sign in again with ${host}`}
        </Button>
        {app === null ? (
          <Button size="sm" variant="outline" onClick={() => setWithToken(true)}>
            Use a pairing token
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}
