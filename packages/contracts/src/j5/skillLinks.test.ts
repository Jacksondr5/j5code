import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  ManagedSkillLink,
  SkillLinkCreate,
  SkillLinkMutationResult,
  SkillLinkRequest,
} from "./skillLinks.ts";

const decodeRequest = Schema.decodeUnknownSync(SkillLinkRequest);
const decodeCreate = Schema.decodeUnknownSync(SkillLinkCreate);
const decodeManagedLink = Schema.decodeUnknownSync(ManagedSkillLink);
const decodeResult = Schema.decodeUnknownSync(SkillLinkMutationResult);
const request = {
  source: { instanceId: "claude-work", path: "C:\\shared\\review\\SKILL.md", name: "review" },
  targetInstanceId: "codex-work",
  scope: "project",
  projectId: "project-1",
};
describe("skill link wire contracts", () => {
  it("requires a source record and provider instance and preserves remote Windows paths", () => {
    expect(decodeRequest(request)).toEqual(request);
    expect(() => decodeRequest({ ...request, scope: "environment" })).toThrow();
    expect(() =>
      decodeRequest({
        ...request,
        source: { path: request.source.path },
      }),
    ).toThrow();
    expect(() => decodeCreate(request)).toThrow();
    const create = {
      ...request,
      expectedSourcePath: "C:\\shared\\review",
      expectedDestinationPath: "C:\\project\\.agents\\skills\\review",
    };
    expect(decodeCreate(create)).toEqual(create);
  });
  it("keeps broken ownership records and successful filesystem writes with failed discovery representable", () => {
    const broken = {
      id: "link-1",
      skillName: "review",
      sourcePath: "C:\\gone",
      destinationPath: "C:\\skills\\review",
      targetInstanceId: "codex-work",
      scope: "user",
      status: "broken",
    };
    expect(decodeManagedLink(broken)).toEqual(broken);
    const result = {
      action: "created",
      discovery: "failed",
      message: "Link created. Refresh failed.",
    };
    expect(decodeResult(result)).toEqual(result);
  });
});
