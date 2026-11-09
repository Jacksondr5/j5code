import { useAtomValue } from "@effect/atom-react";
import {
  type ScopedCrewRuntimeRequest,
  type ScopedNativeQuestionInboxItem,
  toPendingApproval,
} from "@t3tools/client-runtime/j5/crew-inbox-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { PendingApprovalCard } from "../../features/threads/PendingApprovalCard";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { j5Environment } from "../state";
import { readCrewRequestSources } from "./inboxSources";

const requestKey = (request: { environmentId: string; threadId: string; requestId: string }) =>
  `${request.environmentId}:${request.threadId}:${request.requestId}`;

function SectionTitle(props: { readonly title: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="text-xs font-t3-semibold uppercase text-foreground-muted"
    >
      {props.title}
    </Text>
  );
}

/**
 * Crew seats' approvals, answered here with upstream's approval card instead of in the seat's
 * thread (Crews AC9), as web's Inbox answers them. A refused answer's reason stays above the list,
 * since a request that another device resolved leaves it.
 */
export function SeatApprovalsSection(props: {
  readonly requests: ReadonlyArray<ScopedCrewRuntimeRequest>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (props.requests.length === 0 && error === null) return null;
  return (
    <View className="gap-3">
      <SectionTitle title="Crew agent requests" />
      {error === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {error}
        </Text>
      )}
      {props.requests.map((request) => (
        <SeatApproval key={requestKey(request)} request={request} onError={setError} />
      ))}
    </View>
  );
}

function SeatApproval(props: {
  readonly request: ScopedCrewRuntimeRequest;
  readonly onError: (message: string | null) => void;
}) {
  const { request, onError } = props;
  const openLinkedThread = useOpenLinkedThread();
  const canRespond = useAtomValue(
    j5Environment.respondCrewRuntimeRequest.permissionAtom(request.environmentId),
  );
  const respond = useAtomCommand(j5Environment.respondCrewRuntimeRequest, {
    reportFailure: false,
  });
  const [responding, setResponding] = useState(false);
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-sm font-t3-semibold" numberOfLines={1}>
          {request.crewName} · {request.seat}
        </Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open ${request.threadTitle}`}
          hitSlop={6}
          onPress={() =>
            openLinkedThread({
              environmentId: String(request.environmentId),
              threadId: String(request.threadId),
            })
          }
        >
          <Text className="font-t3-medium text-sm text-foreground-secondary">Open thread</Text>
        </Pressable>
      </View>
      <PendingApprovalCard
        canOperateThread={canRespond}
        approval={toPendingApproval(request)}
        respondingApprovalId={responding ? request.requestId : null}
        onRespond={async (requestId, decision) => {
          if (responding) return;
          setResponding(true);
          onError(null);
          const result = await respond({
            environmentId: request.environmentId,
            input: { threadId: request.threadId, requestId, decision },
          });
          // An answer that lost a race with another device is refused, and says so; either way
          // the list is read again so a resolved request leaves.
          if (result._tag === "Failure") {
            const failure = squashAtomCommandFailure(result);
            onError(failure instanceof Error ? failure.message : "Could not answer the request.");
          }
          await readCrewRequestSources(request.environmentId);
          setResponding(false);
          return result;
        }}
      />
    </View>
  );
}

/**
 * Questions agents asked through their provider's own question tool. The answer is given in the
 * agent's thread, so the Inbox links there, as web's does.
 */
export function AgentQuestionsSection(props: {
  readonly questions: ReadonlyArray<ScopedNativeQuestionInboxItem>;
  readonly showEnvironment: boolean;
}) {
  const projects = useProjects();
  const openLinkedThread = useOpenLinkedThread();
  if (props.questions.length === 0) return null;
  return (
    <View className="gap-3">
      <SectionTitle title="Agent questions" />
      {props.questions.map((question) => {
        const project = projects.find(
          (candidate) =>
            candidate.environmentId === question.environmentId &&
            candidate.id === question.projectId,
        );
        const meta = [
          project?.title,
          question.crew?.name,
          question.crew?.seat,
          props.showEnvironment || !question.connected
            ? `${props.showEnvironment ? question.environmentLabel : ""}${question.connected ? "" : props.showEnvironment ? " (offline)" : "offline"}`
            : null,
        ].filter((part): part is string => part !== undefined && part !== null && part !== "");
        return (
          <View key={requestKey(question)} className="gap-1 rounded-2xl bg-card px-4 py-3">
            <Text className="text-base font-t3-semibold">{question.threadTitle}</Text>
            {meta.length === 0 ? null : (
              <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                {meta.join(" · ")}
              </Text>
            )}
            <Text className="text-sm text-foreground-secondary">
              {question.responseCapability === "live"
                ? "Waiting for an answer to continue."
                : "Asked a question while continuing its work."}
            </Text>
            <Pressable
              accessibilityRole="link"
              accessibilityState={{ disabled: !question.connected }}
              disabled={!question.connected}
              hitSlop={6}
              onPress={() =>
                openLinkedThread({
                  environmentId: String(question.environmentId),
                  threadId: String(question.threadId),
                })
              }
            >
              <Text
                className={`font-t3-medium text-sm ${question.connected ? "text-foreground-secondary" : "text-foreground-muted"}`}
              >
                {question.connected ? "Open question" : "Its server is offline"}
              </Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
