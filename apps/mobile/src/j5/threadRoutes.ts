import { createNativeStackScreen } from "@react-navigation/native-stack";

import { ThreadArtifactScreen, ThreadArtifactsScreen } from "./artifacts/ThreadArtifactsScreen";
import { CrewProposalReviewScreen } from "./crew/CrewProposalReviewScreen";

/** J5's thread-scoped screens, beside upstream's thread file routes (FORK.md "Route registration"). */
export const j5ThreadRoutes = <Options extends object>(
  threadLinkingPrefix: string,
  options: Options,
) => ({
  ThreadArtifacts: createNativeStackScreen({
    screen: ThreadArtifactsScreen,
    linking: `${threadLinkingPrefix}/artifacts`,
    options,
  }),
  ThreadArtifact: createNativeStackScreen({
    screen: ThreadArtifactScreen,
    linking: `${threadLinkingPrefix}/artifacts/:path*`,
    options,
  }),
  ThreadCrewProposal: createNativeStackScreen({
    screen: CrewProposalReviewScreen,
    linking: `${threadLinkingPrefix}/crew-proposals/:proposalId`,
    options,
  }),
});
