// Colors follow the app's default light and dark tokens; the window's theme setting drives
// prefers-color-scheme through nativeTheme.themeSource.
export const FIND_BAR_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Find</title><style>
:root { color-scheme: light dark; --bg: #fff; --text: #18181b; --muted: #71717a; --line: #e4e4e7; --hover: #f4f4f5; --ring: #4f46e5; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --text: #f5f5f5; --muted: #a3a3a3; --line: #ffffff24; --hover: #ffffff14; --ring: #6d7cff; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
body { font: 13px/18px system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--text); }
form { display: flex; align-items: center; gap: 6px; height: 100%; padding: 0 4px 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); }
form:focus-within { border-color: var(--ring); }
input { flex: 1; min-width: 0; padding: 0; border: 0; outline: 0; background: transparent; font: inherit; color: inherit; }
output { flex: none; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
button { flex: none; display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: 16px/1 inherit; cursor: pointer; }
button:hover { background: var(--hover); color: var(--text); }
button:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
</style></head><body><form role="search">
<input id="query" type="text" aria-label="Find in page" placeholder="Find" spellcheck="false" autocomplete="off">
<output id="count" aria-live="polite"></output>
<button id="close" type="button" aria-label="Close find">×</button>
</form></body></html>`;
