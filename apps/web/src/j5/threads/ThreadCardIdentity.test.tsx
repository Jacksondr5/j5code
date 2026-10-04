import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "@effect/vitest";

import { ThreadCardIdentity, ThreadCardIdentityView } from "./ThreadCardIdentity";

it("clips a long project name and keeps its full text in the sidebar tooltip pattern", () => {
  const label = "A project with a deliberately long display name that cannot fit the card";
  const markup = renderToStaticMarkup(<ThreadCardIdentity projectName={label} />);

  expect(markup).toContain("block min-w-0 truncate");
  expect(markup).toContain('data-slot="tooltip-trigger"');
  expect(markup).toContain(label);
});

it("adds a seat chip for a crew member and the anchor mark for its Captain", () => {
  const live = { crewInstanceId: "crew:1", crewName: "Review Pair" };
  const member = renderToStaticMarkup(
    <ThreadCardIdentityView
      projectName="Alpha"
      membership={{ kind: "member", seat: "builder", crew: live }}
    />,
  );
  expect(member).toContain("Alpha");
  expect(member).toContain("Review Pair · builder");
  expect(member).toContain('data-testid="thread-card-crew-chip"');

  const captain = renderToStaticMarkup(
    <ThreadCardIdentityView projectName="Alpha" membership={{ kind: "captain", crews: [live] }} />,
  );
  expect(captain).toContain('aria-label="Captain. Commands Review Pair"');
  expect(captain).not.toContain(">Captain<");
  expect(captain).toContain("Commands Review Pair");

  const plain = renderToStaticMarkup(<ThreadCardIdentity projectName="Alpha" />);
  expect(plain).toContain("Alpha");
  expect(plain).not.toContain("thread-card-crew-chip");
});
