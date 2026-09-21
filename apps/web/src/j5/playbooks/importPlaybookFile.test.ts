import { expect, it } from "vite-plus/test";
import { PLAYBOOK_IMPORT_MAX_BYTES, playbookImportName } from "./importPlaybookFile";

it.each([
  ["review.yaml", "review"],
  ["review.yml", "review"],
  ["Review.YAML", "Review"],
  ["Review.YmL", "Review"],
  ["folder/nested/review.yml", "review"],
  ["C:\\folder\\review.yaml", "review"],
  ["révision.v2.yaml", "révision.v2"],
])("maps %s to the playbook name %s", (fileName, name) => {
  expect(playbookImportName(fileName, 100)).toBe(name);
});

it.each([
  "review.txt",
  "review.yaml.bak",
  "",
  ".yaml",
  ".yml",
  "bad\nname.yaml",
  "bad\u0000name.yml",
])("rejects invalid file name %j and identifies it in the error", (fileName) => {
  expect(() => playbookImportName(fileName, 100)).toThrow(`"${fileName}"`);
});

it("accepts the server size limit and rejects larger files", () => {
  expect(playbookImportName("review.yaml", PLAYBOOK_IMPORT_MAX_BYTES)).toBe("review");
  expect(() => playbookImportName("review.yaml", PLAYBOOK_IMPORT_MAX_BYTES + 1)).toThrow(
    '"review.yaml"',
  );
});
