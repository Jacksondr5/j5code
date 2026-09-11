import {
  ArtifactContent,
  ArtifactListResponse,
  ArtifactMcpFailure,
  ArtifactReadInput,
  ArtifactWriteInput,
  ArtifactWriteResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import { ArtifactMcpService } from "../../ArtifactMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ArtifactMcpService];

export const ListArtifactsTool = Tool.make("list_artifacts", {
  description:
    "List durable planning artifacts shared by every thread and agent in the current project.",
  success: ArtifactListResponse,
  failure: ArtifactMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List project artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ReadArtifactTool = Tool.make("read_artifact", {
  description:
    "Read one project artifact by its path relative to artifacts/, such as plan.md or diagrams/flow.svg.",
  parameters: ArtifactReadInput,
  success: ArtifactContent,
  failure: ArtifactMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a project artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const WriteArtifactTool = Tool.make("write_artifact", {
  description:
    "Create or replace a durable, user-consumable planning artifact shared across the current project's threads and agents. Use this for plans, specifications, diagrams, and research notes—not source code, build output, logs, scratch files, or ordinary repository documentation. The path is relative to artifacts/ and content must be UTF-8 text; HTML, Markdown, Mermaid, and SVG are supported.",
  parameters: ArtifactWriteInput,
  success: ArtifactWriteResult,
  failure: ArtifactMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Write a project artifact")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

export const ArtifactToolkit = Toolkit.make(ListArtifactsTool, ReadArtifactTool, WriteArtifactTool);
