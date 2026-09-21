import { createJ5ReadSourcesAtom } from "@t3tools/client-runtime/j5/readSources";
import type { EnvironmentId } from "@t3tools/contracts";
import { sourcesInput } from "../state";
import { playbookApprovalCountQuery, playbookListAtom } from "./queries";

export const playbookInboxQuery = (environmentId: EnvironmentId) =>
  playbookListAtom({
    environmentId,
    input: { squadronId: "", search: "", status: "waiting_approval", page: 0, pageSize: 50 },
  });

export const playbookInboxSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:playbook-inbox",
  capability: "j5HumanInbox",
  queryAtom: playbookInboxQuery,
});

export const playbookInboxCountSourcesAtom = createJ5ReadSourcesAtom({
  ...sourcesInput,
  label: "web-j5:playbook-inbox-count",
  capability: "j5HumanInbox",
  queryAtom: playbookApprovalCountQuery,
});
