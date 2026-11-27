import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
} from "../components/auth/PairingRouteSurface";
import { JoinLinkPairingSurface } from "../j5/sharing/JoinLinkPairingSurface";
import { AppSignInRetry, isAppSignInRetry } from "../j5/sharing/SignInPairing";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }
    // J5: an app's sign-in comes back here to retry, in a paired browser too (FORK.md case 73).
    if (isAppSignInRetry(window.location.href))
      return { authGateState: null, appSignInRetry: true };

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "guest"
    ) {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const router = useRouter();
  const { authGateState, appSignInRetry } = Route.useRouteContext();
  if (appSignInRetry === true) return <AppSignInRetry />;

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface />;
  }

  return (
    <JoinLinkPairingSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        // Recreate the connection so WebSocket and cached scopes use the new pairing cookie.
        router.history.replace("/");
        router.history.flush();
        window.location.reload();
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
