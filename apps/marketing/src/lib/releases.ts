const REPO = "Jacksondr5/j5code";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = "j5code-latest-release";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(): Promise<Release> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  // A rate limit (403) or a missing release (404) still resolves with a JSON
  // error body, so check both the status and the shape before trusting it.
  const response = await fetch(API_URL);
  if (!response.ok) throw new Error(`GitHub releases API returned ${response.status}`);
  const data = (await response.json()) as Partial<Release>;
  if (typeof data.tag_name !== "string" || !Array.isArray(data.assets)) {
    throw new Error("GitHub releases API returned no release");
  }

  sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  return data as Release;
}

/** The Apple Silicon DMG is the only desktop artifact the fork publishes today. */
export function pickMacAsset(assets: ReleaseAsset[]): string | undefined {
  return assets.find((a) => a.name.endsWith("-arm64.dmg"))?.browser_download_url;
}

export function detectPlatform(): "mac" | "win" | "linux" | undefined {
  const ua = navigator.userAgent;
  // iPhones and older iPads cannot run the DMG. Modern iPadOS reports a
  // Macintosh user agent and is indistinguishable here.
  if (/iPhone|iPad|iPod/.test(ua)) return undefined;
  if (/Mac/.test(ua)) return "mac";
  if (/Win/.test(ua)) return "win";
  if (/Linux|X11/.test(ua)) return "linux";
  return undefined;
}
