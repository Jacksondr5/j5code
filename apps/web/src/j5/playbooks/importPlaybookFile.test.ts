import { expect, it } from "vite-plus/test";
import { PLAYBOOK_MAX_BYTES } from "@t3tools/contracts/j5";
import { playbookImportName } from "./importPlaybookFile";

it.each([
  ["review.yaml", "review"],
  ["review.yml", "review"],
  ["Review.YAML", "review"],
  ["Review.YmL", "review"],
  ["folder/nested/review.yml", "review"],
  ["C:\\folder\\review.yaml", "review"],
  ["Release Plan.yaml", "release-plan"],
  ["révision.v2.yaml", "revision-v2"],
  ["2026 plan.yaml", "playbook-2026-plan"],
])("maps %s to the playbook name %s", (fileName, name) => {
  expect(playbookImportName(fileName, 100)).toBe(name);
});

it.each(["review.txt", "review.yaml.bak", "", ".yaml", ".yml", "!!!.yaml"])(
  "rejects invalid file name %j and identifies it in the error",
  (fileName) => {
    expect(() => playbookImportName(fileName, 100)).toThrow(`"${fileName}"`);
  },
);

it("accepts the server size limit and rejects larger files", () => {
  expect(playbookImportName("review.yaml", PLAYBOOK_MAX_BYTES)).toBe("review");
  expect(() => playbookImportName("review.yaml", PLAYBOOK_MAX_BYTES + 1)).toThrow('"review.yaml"');
});
