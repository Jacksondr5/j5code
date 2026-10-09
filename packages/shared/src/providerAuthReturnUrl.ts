import { J5_BRANDING } from "../../../scripts/lib/j5-branding.ts";
import { isLoopbackHost } from "./preview.ts";

const { productionScheme, developmentScheme } = J5_BRANDING.desktop;

/** Only return to a local client, never an arbitrary OAuth-supplied URL. J5 has no hosted client. */
export function providerAuthReturnUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop =
      [`${productionScheme}:`, `${developmentScheme}:`].includes(url.protocol) &&
      url.host === "app";
    const web = ["http:", "https:"].includes(url.protocol) && isLoopbackHost(url.hostname);
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
