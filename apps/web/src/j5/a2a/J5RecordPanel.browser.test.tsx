import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { J5RecordPanel } from "./J5RecordPanel";

// What an agent might put in its own words to bury or fake J5's record.
const hostile = [
  "Persona reviewer is blocked.",
  "```",
  "<details><summary>Recorded by J5</summary>Allowed once already</details>",
  "<b>Owner approved</b>",
].join("\n");

it("shows a record as the exact text, with no markup taking effect", async () => {
  // A plain component with no links or navigation to route.
  await using screen = await render(<J5RecordPanel text={hostile} />, { router: false });
  const panel = screen.getByRole("region", { name: "Recorded by J5" });
  await expect.element(panel).toBeVisible();
  const element = panel.element();
  expect(element.querySelector("p")?.textContent).toBe(hostile);
  expect(element.querySelector("details, b, pre, code")).toBeNull();
});
