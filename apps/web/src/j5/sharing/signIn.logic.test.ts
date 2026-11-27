import { describe, expect, it } from "vite-plus/test";

import {
  desktopAppScheme,
  serverBaseFromHost,
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

describe("sign-in from the desktop app", () => {
  it("knows its own scheme only inside the desktop app", () => {
    expect(desktopAppScheme("j5code:")).toBe("j5code");
    expect(desktopAppScheme("j5code-dev:")).toBe("j5code-dev");
    expect(desktopAppScheme("https:")).toBeNull();
  });

  it("turns a typed host into a server address", () => {
    expect(serverBaseFromHost("j5.example.test")).toBe("https://j5.example.test");
    expect(serverBaseFromHost("192.0.2.4:3773")).toBe("http://192.0.2.4:3773");
    expect(serverBaseFromHost("localhost:3773")).toBe("http://localhost:3773");
    expect(serverBaseFromHost("http://j5.example.test/pair")).toBe("http://j5.example.test");
    expect(serverBaseFromHost("  ")).toBeNull();
  });
});
