import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  adjudicationAsks,
  commandsACrew,
  pickShownAsk,
} from "@t3tools/client-runtime/j5/adjudication-dock";
import { closedLine, mergeHumanInboxSources } from "@t3tools/client-runtime/j5/inbox";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { relativeTime } from "../../lib/time";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useCrewMembership } from "../crew/crewMemberships";
import { useInboxAnswers } from "../inbox/inboxAnswers";
import { answeredInboxSourcesAtom, openInboxSourcesAtom } from "../inbox/inboxSources";
import { j5Sharing } from "../sharing/guestAccess";
import { j5Environment } from "../state";

/** About three lines of the question while the dock is opened but not in full. */
const EXCERPT_HEIGHT = 72;

const URGENCY = {
  blocking: { label: "Blocking", className: "text-danger-foreground" },
  soon: { label: "Soon", className: "text-warning-foreground" },
  fyi: { label: "FYI", className: "text-foreground-muted" },
} as const;

/**
 * A Captain's open asks to the person, pinned above its composer as web's dock is. They are the
 * Inbox's own asks, answered through the same command, so answering here or there closes the one
 * Exchange (Crews: adjudication request). Only a Captain's asks are pinned; others stay in the Inbox.
 */
export function AdjudicationDock(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const membership = useCrewMembership(scopeThreadRef(props.environmentId, props.threadId));
  // The Inbox is read only for a Captain's thread.
  return commandsACrew(membership) ? <CaptainAsks {...props} /> : null;
}

function CaptainAsks(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const openSources = useAtomValue(openInboxSourcesAtom);
  const answeredSources = useAtomValue(answeredInboxSourcesAtom);
  const ofThisEnvironment = (items: ReturnType<typeof mergeHumanInboxSources>) =>
    items.filter((item) => item.environmentId === environmentId);
  const answers = useInboxAnswers({
    openSources,
    items: ofThisEnvironment(mergeHumanInboxSources(openSources)),
    answeredSources,
    answered: ofThisEnvironment(mergeHumanInboxSources(answeredSources)),
  });
  const mayAnswer = useAtomValue(j5Environment.answerHumanExchange.permissionAtom(environmentId));
  const access = useAtomValue(j5Sharing.connectionAccess(environmentId));
  const styles = useMarkdownPreviewStyles();
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  // The ask whose question runs past the excerpt's height.
  const [overflowing, setOverflowing] = useState<string | null>(null);

  // An ask that closed while the person had typed into it stays, with who answered (Inbox AC17).
  const asks = adjudicationAsks({
    items: answers.shownItems,
    refused: [],
    threadId,
    hasWords: () => true,
  });
  const view = pickShownAsk(asks, picked);
  if (!mayAnswer || view === null) return null;
  const { shown, others, next: nextAsk } = view;
  const urgency = URGENCY[shown.urgency];
  const closed = answers.closedOf(shown);
  const closedText =
    closed === undefined
      ? null
      : closedLine({ ...closed, ownName: access?.kind === "person" ? access.name : null });
  const text = answers.answerText(shown);
  const delivering = answers.pendingKey !== null;
  const error = answers.errorFor(shown);
  // Measured, not counted: a few short lines can still wrap past the excerpt on a phone.
  const longer = full || overflowing === shown.exchangeId;
  const markdown = (value: string) => (
    <SelectableMarkdownText markdown={value} textStyle={styles.nativeTextStyle} />
  );

  return (
    <View className="px-4 pb-2" testID="adjudication-dock">
      <View className="rounded-[20px] border-continuous bg-card px-3 py-1">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`Question for you, ${urgency.label}: ${shown.intent}`}
          onPress={() => setOpen((value) => !value)}
          className="min-h-11 flex-row items-center gap-2"
        >
          <SymbolView name="questionmark.bubble" size={14} tintColorClassName="accent-icon-muted" />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              Question for you · open {relativeTime(shown.openedAt)}
            </Text>
            <Text
              numberOfLines={open ? undefined : 1}
              className="text-xs font-t3-medium text-foreground"
            >
              {shown.intent}
            </Text>
          </View>
          <Text className={`text-2xs font-t3-semibold uppercase ${urgency.className}`}>
            {urgency.label}
          </Text>
          <SymbolView
            name={open ? "chevron.down" : "chevron.right"}
            size={12}
            tintColorClassName="accent-icon-muted"
          />
        </Pressable>
        {open ? (
          <View className="gap-2 pb-2">
            <ScrollView
              // Remounted per ask, so each reports its own content size.
              key={shown.exchangeId}
              style={{ maxHeight: full ? 280 : EXCERPT_HEIGHT }}
              scrollEnabled={full}
              nestedScrollEnabled
              onContentSizeChange={(_width, height) =>
                setOverflowing(height > EXCERPT_HEIGHT ? shown.exchangeId : null)
              }
            >
              <View className="gap-2">
                {markdown(shown.message)}
                {[shown.escalation?.summary, shown.personaDraft?.summary].map((record) =>
                  record === undefined ? null : (
                    // J5's own record, apart from the agent's words; plain text, so they can't alter it.
                    <View key={record} className="gap-1 rounded-lg bg-subtle px-3 py-2">
                      <Text className="text-xs font-t3-medium text-foreground-muted">
                        Recorded by J5
                      </Text>
                      <Text className="text-sm">{record}</Text>
                    </View>
                  ),
                )}
                {shown.followUps?.map((followUp) => (
                  <View className="gap-1" key={followUp.messageId}>
                    <Text className="text-xs font-t3-medium text-foreground-muted">Follow-up</Text>
                    {markdown(followUp.message)}
                  </View>
                ))}
              </View>
            </ScrollView>
            {longer ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={6}
                onPress={() => setFull((value) => !value)}
              >
                <Text className="text-xs font-t3-medium text-foreground-secondary">
                  {full ? "Show less" : "Show full question"}
                </Text>
              </Pressable>
            ) : null}
            <TextInput
              accessibilityLabel={`Answer ${shown.intent}`}
              multiline
              placeholder="Type the answer exactly as it should be delivered"
              value={text}
              onChangeText={(value) => answers.setAnswerText(shown, value)}
              style={{ minHeight: 44, maxHeight: 120, textAlignVertical: "top" }}
            />
            {error === null ? null : (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {error}
              </Text>
            )}
            <View className="flex-row items-center justify-end gap-2">
              {closedText !== null ? (
                <Text className="text-sm text-foreground-muted">{closedText}</Text>
              ) : (
                <Button
                  label={delivering ? "Delivering…" : "Answer"}
                  tone="primary"
                  size="compact"
                  loading={delivering}
                  disabled={!shown.sourceReady || delivering || text.length === 0}
                  onPress={() => void answers.answer(shown)}
                />
              )}
            </View>
          </View>
        ) : null}
        {nextAsk !== null ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setPicked(nextAsk.exchangeId);
              setFull(false);
            }}
            className="min-h-9 flex-row items-center gap-1 border-t border-border-subtle"
          >
            <Text className="shrink-0 text-xs text-foreground">
              {others.length} more {others.length === 1 ? "question" : "questions"}
            </Text>
            <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
              · {nextAsk.intent}
            </Text>
            <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
