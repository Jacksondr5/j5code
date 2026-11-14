import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { A2ADeliveryWorker } from "../a2a/DeliveryWorker.ts";
import { A2AHomeRegistrar } from "../a2a/HomeRegistrar.ts";
import { A2ALedger } from "../a2a/LedgerService.ts";
import { A2ASendService } from "../a2a/SendService.ts";
import { AgentCrewInstanceService } from "../a2a/AgentCrewInstanceService.ts";
import { ArchiveCrewService } from "../a2a/ArchiveCrewService.ts";
import { CrewProposalService } from "../a2a/CrewProposalService.ts";
import { CrewStopService } from "../a2a/CrewStopService.ts";
import { ParticipantPlacementService } from "../a2a/PlacementService.ts";
import { PeerDirectory } from "../a2a/PeerDirectory.ts";
import { PeerRegistryService } from "../a2a/PeerRegistryService.ts";
import { RequestReplayService } from "../a2a/RequestReplayService.ts";
import { SpawnAgentService } from "../a2a/SpawnAgentService.ts";
import { SpawnCompositionService } from "../a2a/SpawnCompositionService.ts";
import { SpawnWorkspaceService } from "../a2a/spawnWorkspace.ts";
import { ThreadRegistration } from "../a2a/ThreadRegistration.ts";
import { AgentPersonaDrafts } from "../agents/agentPersonaDrafts.ts";
import { AgentPersonaEscalations } from "../agents/agentPersonaEscalation.ts";
import { CrewMemberModels } from "../agents/crewMemberModels.ts";
import { PlaybookCrewRelay } from "../playbooks/PlaybookCrewRelay.ts";
import { PlaybookStore } from "../playbooks/PlaybookStore.ts";

/** Unused stand-ins for what J5's MCP tools need, for tests that only list the tools. */
export const j5ToolHandlerMocks = Layer.mergeAll(
  Layer.mock(A2ADeliveryWorker)({}),
  Layer.mock(A2AHomeRegistrar)({}),
  Layer.mock(A2ALedger)({}),
  Layer.mock(A2ASendService)({}),
  Layer.mock(AgentCrewInstanceService)({}),
  Layer.mock(AgentPersonaDrafts)({}),
  Layer.mock(AgentPersonaEscalations)({}),
  Layer.mock(ArchiveCrewService)({}),
  Layer.mock(CrewMemberModels)({}),
  Layer.mock(CrewProposalService)({}),
  Layer.mock(CrewStopService)({}),
  Layer.mock(ParticipantPlacementService)({}),
  Layer.mock(PeerDirectory)({}),
  Layer.mock(PeerRegistryService)({}),
  Layer.mock(PlaybookCrewRelay)({}),
  Layer.mock(PlaybookStore)({}),
  Layer.mock(RequestReplayService)({}),
  Layer.mock(SpawnAgentService)({}),
  Layer.mock(SpawnCompositionService)({}),
  Layer.mock(SpawnWorkspaceService)({}),
  Layer.mock(ThreadRegistration)({}),
  NodeSqliteClient.layer({ filename: ":memory:" }),
);
