// Explicit old IDs for the unchanged steps now composed by upstream migration 51.
import OrchestrationV2Subagents from "../../persistence/Migrations/OrchestrationV2/Subagents.ts";
import OrchestrationV2Foundation from "../../persistence/Migrations/OrchestrationV2/Foundation.ts";
import OrchestrationV2ProviderSessionBindings from "../../persistence/Migrations/OrchestrationV2/ProviderSessionBindings.ts";
import OrchestrationV2ThreadLaunchWorkflows from "../../persistence/Migrations/OrchestrationV2/ThreadLaunchWorkflows.ts";
import ApplicationEventSource from "../../persistence/Migrations/OrchestrationV2/ApplicationEventSource.ts";
import OrchestrationV2EffectCancellation from "../../persistence/Migrations/OrchestrationV2/EffectCancellation.ts";
import ScheduledTasks from "../../persistence/Migrations/OrchestrationV2/ScheduledTasks.ts";
import LegacyV1ImportState from "../../persistence/Migrations/OrchestrationV2/LegacyV1ImportState.ts";
import ApplicationEventSequenceIndexes from "../../persistence/Migrations/OrchestrationV2/ApplicationEventSequenceIndexes.ts";
import OrchestrationV2RecoveryIndexes from "../../persistence/Migrations/OrchestrationV2/RecoveryIndexes.ts";
import OrchestrationV2ShellIndexes from "../../persistence/Migrations/OrchestrationV2/ShellIndexes.ts";

export const septemberV2RemainingSteps = [
  [49, "OrchestrationV2Subagents", OrchestrationV2Subagents],
  [50, "OrchestrationV2Foundation", OrchestrationV2Foundation],
  [51, "OrchestrationV2ProviderSessionBindings", OrchestrationV2ProviderSessionBindings],
  [52, "OrchestrationV2ThreadLaunchWorkflows", OrchestrationV2ThreadLaunchWorkflows],
  [53, "ApplicationEventSource", ApplicationEventSource],
  [54, "OrchestrationV2EffectCancellation", OrchestrationV2EffectCancellation],
  [55, "ScheduledTasks", ScheduledTasks],
  [56, "LegacyV1ImportState", LegacyV1ImportState],
  [57, "ApplicationEventSequenceIndexes", ApplicationEventSequenceIndexes],
  [58, "OrchestrationV2RecoveryIndexes", OrchestrationV2RecoveryIndexes],
  [59, "OrchestrationV2ShellIndexes", OrchestrationV2ShellIndexes],
] as const;
