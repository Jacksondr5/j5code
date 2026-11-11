import { describe, expect, it } from "vite-plus/test";

import { serverPromptLinkUrl } from "./promptLink";
import { readThreadLinkPage } from "./threadLink";

describe("readThreadLinkPage", () => {
  it("opens the thread in the app and on a server", () => {
    const page = readThreadLinkPage("https://j5.codes/threads/env-1/thread_2/");
    expect(page).toEqual({
      ok: true,
      value: { appPath: "/env-1/thread_2", deepLink: "j5code://threads/env-1/thread_2" },
    });
    expect(page.ok && serverPromptLinkUrl("localhost:3773", page.value.appPath)).toBe(
      "http://localhost:3773/env-1/thread_2",
    );
  });

  it("keeps escaped ids as the link wrote them", () => {
    const page = readThreadLinkPage("https://j5.codes/threads/env%2E1/thread%20two");
    expect(page.ok && page.value.deepLink).toBe("j5code://threads/env%2E1/thread%20two");
  });

  it("refuses a link that doesn't name a thread", () => {
    for (const href of [
      "https://j5.codes/threads",
      "https://j5.codes/threads/env-1",
      "https://j5.codes/threads/env-1/thread-1/extra",
      "https://j5.codes/threads/env-1/%E0%A4",
      "https://j5.codes/threads/%20/thread-1",
      "https://j5.codes/threads/env.1/thread-1",
    ]) {
      expect(readThreadLinkPage(href)).toEqual({
        ok: false,
        error: "This link doesn't name a thread.",
      });
    }
  });
});
