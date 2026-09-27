import { Toolkit } from "effect/unstable/ai";

import { AttachmentToolkit } from "../../../mcp/toolkits/attachment/tools.ts";
import { EnvironmentToolkit } from "../../../mcp/toolkits/environment/tools.ts";
import { OrchestratorToolkit } from "../../../mcp/toolkits/orchestrator/tools.ts";
import { ProjectToolkit } from "../../../mcp/toolkits/project/tools.ts";
import { ThreadToolkit } from "../../../mcp/toolkits/thread/tools.ts";

// Original tool objects reuse upstream handler services without registering
// their excluded siblings. Keep this catalog explicit when upstream adds tools.
export const J5EnvironmentToolkit = Toolkit.make(EnvironmentToolkit.tools.t3_environment_read);

export const J5ProjectToolkit = Toolkit.make(
  ProjectToolkit.tools.t3_project_list,
  ProjectToolkit.tools.t3_project_read,
  ProjectToolkit.tools.t3_project_clone,
);

export const J5AttachmentUploadToolkit = Toolkit.make(
  AttachmentToolkit.tools.t3_attachment_prepare_upload,
  AttachmentToolkit.tools.t3_attachment_discard,
);

export const J5ThreadMetadataToolkit = Toolkit.make(OrchestratorToolkit.tools.t3_thread_update);

export const J5ThreadToolkit = Toolkit.make(
  ThreadToolkit.tools.t3_queue_list,
  ThreadToolkit.tools.t3_queue_read,
  ThreadToolkit.tools.t3_pending_request_list,
  ThreadToolkit.tools.t3_pending_request_read,
  ThreadToolkit.tools.t3_pending_request_respond,
  ThreadToolkit.tools.t3_thread_configuration,
  ThreadToolkit.tools.t3_thread_configure,
  ThreadToolkit.tools.t3_thread_transfers,
  ThreadToolkit.tools.t3_thread_search,
  ThreadToolkit.tools.run_scheduled_task_now,
);
