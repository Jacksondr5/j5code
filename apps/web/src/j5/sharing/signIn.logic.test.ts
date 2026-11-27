import { describe, expect, it } from "vite-plus/test";

import {
  appSignInRetryOf,
  desktopAppScheme,
  joinAddresses,
  serverBaseFromHost,
  signInAppOf,
  signInHost,
  signInOutcomeOf,
  signInUrl,
} from "./signIn.logic";

describe("sign-in on the pairing page", () => {
  it("names the J5 Connect only when the server offers sign-in", () => {
    expect(signInHost({ signIn: { host: "connect.example.test" } })).toBe("connect.example.test");
    expect(signInHost({ signIn: null })).toBeNull();
    expect(signInHost("not a description")).toBeNull();
  });

  it("reads what the J5 Connect's return said, and nothing else", () => {
    expect(signInOutcomeOf("https://j5.example.test/pair?j5-sign-in=waiting")).toBe("waiting");
    expect(signInOutcomeOf("https://j5.example.test/pair?j5-sign-in=not-let-in")).toBe(
      "not-let-in",
    );
    expect(signInOutcomeOf("https://j5.example.test/pair?j5-sign-in=granted")).toBeNull();
    expect(signInOutcomeOf("https://j5.example.test/pair#token=abc")).toBeNull();
  });

  it("starts at the server's sign-in path, carrying an app's scheme when it has one", () => {
    expect(signInUrl("https://j5.example.test/")).toBe(
      "https://j5.example.test/api/j5/identity/sign-in",
    );
    expect(signInUrl("http://192.0.2.4:3773", "j5code-dev")).toBe(
      "http://192.0.2.4:3773/api/j5/identity/sign-in?app=j5code-dev",
    );
  });
});

describe("the address a joining server is offered at", () => {
  it("is the page's own only for the server serving the page", () => {
    const page = "https://j5.example.test/settings/people";
    const other = { route: "BearerConnectionTarget", httpBaseUrl: "http://192.0.2.4:3773/" };
    expect(joinAddresses({ servesPage: true, pageHref: page, reachedAt: other })).toEqual([
      "https://j5.example.test",
    ]);
    expect(joinAddresses({ servesPage: false, pageHref: page, reachedAt: other })).toEqual([
      "http://192.0.2.4:3773",
    ]);
    expect(joinAddresses({ servesPage: false, pageHref: page, reachedAt: null })).toEqual([]);
    // An SSH tunnel's loopback port changes with each tunnel, and a relay's address isn't the server's.
    for (const route of ["SshConnectionTarget", "RelayConnectionTarget"]) {
      const tunnel = { route, httpBaseUrl: "http://127.0.0.1:41234/" };
      expect(joinAddresses({ servesPage: false, pageHref: page, reachedAt: tunnel })).toEqual([]);
    }
    expect(
      joinAddresses({ servesPage: true, pageHref: "j5code://app/settings", reachedAt: null }),
    ).toEqual([]);
  });
});

describe("sign-in from the desktop app", () => {
  it("knows its own scheme only inside the desktop app", () => {
    expect(desktopAppScheme("j5code:")).toBe("j5code");
    expect(desktopAppScheme("j5code-dev:")).toBe("j5code-dev");
    expect(desktopAppScheme("j5code-preview:")).toBe("j5code-preview");
    expect(desktopAppScheme("j5code-evil:")).toBeNull();
    expect(desktopAppScheme("https:")).toBeNull();
  });

  it("keeps the app a sign-in came back from, so the next try goes back to it", () => {
    expect(signInAppOf("https://j5.example.test/pair?j5-sign-in=waiting&app=j5code")).toBe(
      "j5code",
    );
    expect(signInAppOf("https://j5.example.test/pair?j5-sign-in=waiting&app=j5code-evil")).toBe(
      null,
    );
    expect(signInAppOf("https://j5.example.test/pair?j5-sign-in=waiting")).toBeNull();
  });

  it("shows an app's retry only for an outcome and an allowed app together", () => {
    expect(appSignInRetryOf("https://j5.example.test/pair?j5-sign-in=waiting&app=j5code")).toEqual({
      outcome: "waiting",
      app: "j5code",
    });
    expect(
      appSignInRetryOf("https://j5.example.test/pair?j5-sign-in=not-let-in&app=j5code-preview"),
    ).toEqual({ outcome: "not-let-in", app: "j5code-preview" });
    expect(appSignInRetryOf("https://j5.example.test/pair?j5-sign-in=waiting")).toBeNull();
    expect(appSignInRetryOf("https://j5.example.test/pair?app=j5code")).toBeNull();
    expect(
      appSignInRetryOf("https://j5.example.test/pair?j5-sign-in=waiting&app=j5code-evil"),
    ).toBeNull();
  });

  it("turns a typed host into a server address", () => {
    expect(serverBaseFromHost("j5.example.test")).toBe("https://j5.example.test");
    // A name goes to HTTPS, with a port too, as upstream reads a host; only this machine and an
    // IP address stay plain HTTP.
    expect(serverBaseFromHost("j5.example.test:3773")).toBe("https://j5.example.test:3773");
    expect(serverBaseFromHost("192.0.2.4:3773")).toBe("http://192.0.2.4:3773");
    expect(serverBaseFromHost("localhost:3773")).toBe("http://localhost:3773");
    expect(serverBaseFromHost("http://j5.example.test/pair")).toBe("http://j5.example.test");
    expect(serverBaseFromHost("  ")).toBeNull();
  });
});
