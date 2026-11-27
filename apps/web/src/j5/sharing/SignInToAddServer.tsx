import { LogInIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { toastManager } from "../../components/ui/toast";
import { ensureLocalApi } from "../../localApi";
import { desktopAppScheme, serverBaseFromHost, signInUrl } from "./signIn.logic";

/**
 * In the desktop app's Add environment dialog: sign in at the server typed in, through the system
 * browser. A sign-in that pairs comes back as the app's own pairing link, which the desktop app
 * already opens (`DesktopWebLinkCoordinator`), so no new channel into the app is needed.
 */
export function SignInToAddServer({
  host,
  disabled,
}: {
  readonly host: string;
  readonly disabled: boolean;
}) {
  const scheme = desktopAppScheme(window.location.protocol);
  if (scheme === null) return null;
  const base = serverBaseFromHost(host);
  const open = async () => {
    if (base === null) return;
    try {
      await ensureLocalApi().shell.openExternal(signInUrl(base, scheme));
    } catch {
      toastManager.add({ type: "error", title: "Could not open the browser to sign in" });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || base === null}
        onClick={() => void open()}
      >
        <LogInIcon className="size-3" />
        Sign in instead
      </Button>
      <span className="text-2xs text-muted-foreground">
        If this server trusts a J5 Connect, sign in there in your browser instead of pasting a code.
      </span>
    </div>
  );
}
