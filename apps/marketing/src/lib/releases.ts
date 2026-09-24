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

  const data = await fetch(API_URL).then((r) => r.json());

  if (data?.assets) {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(data));
  }

  return data;
}

/** The Apple Silicon DMG is the only desktop artifact the fork publishes today. */
export function pickMacAsset(assets: ReleaseAsset[]): string | undefined {
  return assets.find((a) => a.name.endsWith("-arm64.dmg"))?.browser_download_url;
}

export function detectPlatform(): "mac" | "win" | "linux" | undefined {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "mac";
  if (/Win/.test(ua)) return "win";
  if (/Linux|X11/.test(ua)) return "linux";
  return undefined;
}
