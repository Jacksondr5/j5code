import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "@effect/vitest";

import { ThreadCardIdentity, ThreadCardIdentityView } from "./ThreadCardIdentity";

it("leads a registered thread card with its Registrar Squadron instead of its folder", () => {
  const markup = renderToStaticMarkup(
    <ThreadCardIdentity
      home={{ kind: "known", squadron: { id: "squadron:alpha", name: "Alpha" } }}
      fallbackFolder="Shared folder"
    />,
  );

  expect(markup).toContain("Alpha");
  expect(markup).not.toContain("Shared folder");
});

it("keeps the existing folder label for a thread without a Registrar home", () => {
  const markup = renderToStaticMarkup(
    <ThreadCardIdentity home={{ kind: "unknown" }} fallbackFolder="Native folder" />,
  );

  expect(markup).toContain("Native folder");
});

it("clips a long identity label and keeps its full text in the sidebar tooltip pattern", () => {
  const label = "J5 disposable A2A evidence Squadron with a deliberately long label";
  const markup = renderToStaticMarkup(
    <ThreadCardIdentity
      home={{ kind: "known", squadron: { id: "squadron:long", name: label } }}
      fallbackFolder="Shared folder"
    />,
  );

  expect(markup).toContain("block min-w-0 truncate");
  expect(markup).toContain('data-slot="tooltip-trigger"');
  expect(markup).toContain(label);
});

it("keeps two Squadrons over one folder distinguishable", () => {
  const alpha = renderToStaticMarkup(
    <ThreadCardIdentity
      home={{ kind: "known", squadron: { id: "squadron:alpha", name: "Alpha" } }}
      fallbackFolder="Shared folder"
    />,
  );
  const bravo = renderToStaticMarkup(
    <ThreadCardIdentity
      home={{ kind: "known", squadron: { id: "squadron:bravo", name: "Bravo" } }}
      fallbackFolder="Shared folder"
    />,
  );

  expect(alpha).toContain("Alpha");
  expect(bravo).toContain("Bravo");
  expect(alpha).not.toContain("Shared folder");
  expect(bravo).not.toContain("Shared folder");
});

it("adds a seat chip for a crew member and the anchor mark for its Captain, skipping archived crews", () => {
  const home = { kind: "known" as const, squadron: { id: "squadron:alpha", name: "Alpha" } };
  const live = {
    crewInstanceId: "crew:1",
    crewName: "Review Pair",
    archived: false,
  };
  const member = renderToStaticMarkup(
    <ThreadCardIdentityView
      home={home}
      fallbackFolder={null}
      membership={{ kind: "member", seat: "builder", crew: live }}
    />,
  );
  expect(member).toContain("Alpha");
  expect(member).toContain("Review Pair · builder");
  expect(member).toContain('data-testid="thread-card-crew-chip"');

  const captain = renderToStaticMarkup(
    <ThreadCardIdentityView
      home={home}
      fallbackFolder={null}
      membership={{ kind: "captain", crews: [live] }}
    />,
  );
  expect(captain).toContain('aria-label="Captain. Commands Review Pair"');
  expect(captain).not.toContain(">Captain<");
  expect(captain).toContain("Commands Review Pair");

  const archived = renderToStaticMarkup(
    <ThreadCardIdentityView
      home={home}
      fallbackFolder={null}
      membership={{ kind: "member", seat: "builder", crew: { ...live, archived: true } }}
    />,
  );
  expect(archived).not.toContain("thread-card-crew-chip");

  const plain = renderToStaticMarkup(
    <ThreadCardIdentity home={home} fallbackFolder="Shared folder" />,
  );
  expect(plain).toContain("Alpha");
  expect(plain).not.toContain("thread-card-crew-chip");
});
