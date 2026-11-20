import { useAtomValue } from "@effect/atom-react";
import {
  type ScopedCrewRuntimeRequest,
  type ScopedNativeQuestionInboxItem,
  toPendingApproval,
} from "@t3tools/client-runtime/j5/crew-inbox-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProviderApprovalDecision, ProviderApprovalOption } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { J5Card, J5CardEyebrow, J5LinkCard } from "../components/J5Card";
import { J5CompactButton } from "../components/J5CompactButton";
import { j5Environment } from "../state";
import { readCrewRequestSources } from "./inboxSources";

// Upstream's approval card offers these when the provider names none.
const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

// One row of small actions, where upstream's thread card wraps to two.
const ACTION_TONES: Partial<Record<ProviderApprovalDecision, "primary" | "danger">> = {
  accept: "primary",
  decline: "danger",
};

const requestKey = (request: { environmentId: string; threadId: string; requestId: string }) =>
  `${request.environmentId}:${request.threadId}:${request.requestId}`;

/** Upstream's section title: footnote, medium, muted, sentence case. */
function SectionTitle(props: { readonly title: string }) {
  return (
    <Text accessibilityRole="header" className="px-1 text-sm font-t3-medium text-foreground-muted">
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
  const [responding, setResponding] = useState<ProviderApprovalDecision | null>(null);
  const approval = toPendingApproval(request);
  const options = approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const answer = async (decision: ProviderApprovalDecision) => {
    if (responding !== null) return;
    setResponding(decision);
    onError(null);
    const result = await respond({
      environmentId: request.environmentId,
      input: { threadId: request.threadId, requestId: request.requestId, decision },
    });
    // An answer that lost a race with another device is refused, and says so; either way the
    // list is read again so a resolved request leaves.
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      onError(failure instanceof Error ? failure.message : "Could not answer the request.");
    }
    await readCrewRequestSources(request.environmentId);
    setResponding(null);
  };
  return (
    <J5Card className="gap-2">
      <View className="flex-row items-center justify-between gap-2">
        <J5CardEyebrow label={approval.appName ?? approval.requestKind} className="flex-1" />
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`Open ${request.threadTitle}`}
          // Held, but not dimmed, while an answer sends.
          disabled={responding !== null}
          hitSlop={6}
          onPress={() =>
            openLinkedThread({
              environmentId: String(request.environmentId),
              threadId: String(request.threadId),
            })
          }
          className="active:opacity-70"
        >
          <Text className="font-t3-medium text-sm text-primary-text">Open thread</Text>
        </Pressable>
      </View>
      <Text className="text-base font-t3-bold" numberOfLines={1}>
        {request.crewName} · {request.seat}
      </Text>
      {approval.detail ? (
        <Text selectable className="font-mono text-xs">
          {approval.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => (
          <J5CompactButton
            key={option.decision}
            label={option.label}
            tone={ACTION_TONES[option.decision] ?? "secondary"}
            disabled={!canRespond}
            loading={responding === option.decision}
            inactive={responding !== null}
            onPress={() => void answer(option.decision)}
          />
        ))}
      </View>
      {warning === undefined ? null : (
        <Text className="text-xs text-warning-foreground">{warning}</Text>
      )}
      {canRespond ? null : (
        <Text className="text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      )}
    </J5Card>
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
          // The whole card opens the question, where it is answered.
          <J5LinkCard
            key={requestKey(question)}
            accessibilityLabel={`Open question from ${question.threadTitle}`}
            onPress={
              question.connected
                ? () =>
                    openLinkedThread({
                      environmentId: String(question.environmentId),
                      threadId: String(question.threadId),
                    })
                : null
            }
          >
            <Text className="text-base font-t3-bold">{question.threadTitle}</Text>
            {meta.length === 0 ? null : (
              <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                {meta.join(" · ")}
              </Text>
            )}
            <Text className="text-sm text-foreground-secondary">
              {!question.connected
                ? "Its server is offline."
                : question.responseCapability === "live"
                  ? "Waiting for an answer to continue."
                  : "Asked a question while continuing its work."}
            </Text>
          </J5LinkCard>
        );
      })}
    </View>
  );
}
