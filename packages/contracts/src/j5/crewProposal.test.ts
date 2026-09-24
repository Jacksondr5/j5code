import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { CrewProposalResolveRequest } from "../j5.ts";

it("requires a runtime preview token for approval, while a decline needs no preview", () => {
  const decode = Schema.decodeUnknownSync(CrewProposalResolveRequest);
  expect(() => decode({ proposalId: "proposal", decision: "approve" })).toThrow();
  expect(
    decode({ proposalId: "proposal", decision: "approve", approvalToken: "token" }),
  ).toMatchObject({ approvalToken: "token" });
  expect(decode({ proposalId: "proposal", decision: "decline" })).toEqual({
    proposalId: "proposal",
    decision: "decline",
  });
});
