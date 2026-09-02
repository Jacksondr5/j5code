import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "@effect/vitest";

import { ThreadCardIdentity } from "./ThreadCardIdentity";

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
