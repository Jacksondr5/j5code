import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { UsersIcon } from "lucide-react";
import type { ReactNode } from "react";

import ChatMarkdown from "../../components/ChatMarkdown";
import { Badge } from "../../components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../components/ui/tooltip";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  crewGateFooter,
  crewGateTitle,
  presentCrewNotice,
  type CrewNoticeMessage,
  type CrewNoticePresentation,
} from "./crewNotices.logic";

export interface CrewNoticeRenderInput {
  readonly message: CrewNoticeMessage & {
    readonly createdAt: string;
    /** What the person attached to the turn; the launch card lists them by name. */
    readonly attachments?:
      | ReadonlyArray<{ readonly type: string; readonly name?: string }>
      | undefined;
  };
  readonly timestampLabel?: string | undefined;
  readonly participantLabels?: ReadonlyMap<string, string> | undefined;
  /** The thread the timeline shows; seats open on its environment and markdown resolves against it. */
  readonly threadRef?: ScopedThreadRef | null | undefined;
  readonly markdownCwd?: string | undefined;
}

/**
 * The person's `/crew` turn, shown as the brief it is. The guidance block the command sent with
 * it stays one click away rather than filling the bubble, since the agent read it and the person
 * wrote none of it.
 */
function CrewLaunchCard(props: {
  readonly notice: Extract<CrewNoticePresentation, { kind: "launch" }>;
  readonly input: CrewNoticeRenderInput;
}) {
  const { notice, input } = props;
  // Attached terminal and element contexts ride with the brief for the Captain; the card shows
  // the brief the person typed, the way the ordinary user row hides its appended contexts.
  const visibleBrief = deriveDisplayedUserMessageState(notice.brief).visibleText.trim();
  const attachmentNames = (input.message.attachments ?? []).map(
    (attachment) => attachment.name ?? attachment.type,
  );
  return (
    <div className="flex justify-end">
      <section
        className="max-w-[88%] min-w-0 rounded-[10px] border border-border/70 bg-accent px-3.5 py-2.5"
        data-j5-crew-renderer="launch"
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UsersIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">Crew brief</span>
          {input.timestampLabel ? (
            <time className="ms-auto tabular-nums" dateTime={input.message.createdAt}>
              {input.timestampLabel}
            </time>
          ) : null}
        </div>
        <ChatMarkdown
          text={visibleBrief.length > 0 ? visibleBrief : notice.brief}
          cwd={input.markdownCwd}
          threadRef={input.threadRef ?? undefined}
          className="mt-1.5 text-sm text-foreground"
          lineBreaks
          parseRawHtml={false}
        />
        {attachmentNames.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1" aria-label="Attachments">
            {attachmentNames.map((name, index) => (
              <li key={`${name}-${index}`}>
                <Badge variant="outline" className="max-w-56 truncate px-1.5 py-0 text-[11px]">
                  {name}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Guidance sent with the brief
          </summary>
          <p className="mt-1 text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
            {notice.guidance}
          </p>
        </details>
      </section>
    </div>
  );
}

/**
 * The gate's decision as the Captain received it: what was decided, about which Crew, and the
 * roster seat by seat. Every seat opens its thread; its label names the saved agent, not the thread title.
 */
function CrewGateCard(props: {
  readonly notice: Extract<CrewNoticePresentation, { kind: "gate" }>;
  readonly input: CrewNoticeRenderInput;
}) {
  const { notice, input } = props;
  const navigate = useNavigate();
  const environmentId = input.threadRef?.environmentId;
  const approved = notice.decision === "approved";
  const openSeat = (threadId: string) => {
    if (environmentId === undefined) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(threadId))),
    });
  };
  return (
    <section
      className="max-w-[88%] rounded-[10px] border border-border/70 bg-muted/25 px-3.5 py-2.5"
      data-j5-crew-renderer="gate"
      data-j5-crew-decision={notice.decision}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <UsersIcon className="size-3.5 shrink-0" aria-hidden />
          {crewGateTitle(notice)}
        </span>
        {notice.crewName !== null ? (
          <span className="font-medium text-foreground">{notice.crewName}</span>
        ) : null}
        {approved && notice.requestKind === "addition" && notice.crewVersion !== null ? (
          <span className="rounded-md border border-border/70 px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            v{notice.crewVersion}
          </span>
        ) : null}
        {!approved ? (
          <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
            Declined
          </span>
        ) : null}
        {input.timestampLabel ? (
          <time
            className="ms-auto tabular-nums text-muted-foreground"
            dateTime={input.message.createdAt}
          >
            {input.timestampLabel}
          </time>
        ) : null}
      </div>
      {approved && notice.changes !== null ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          You changed the roster: {notice.changes}.
        </p>
      ) : null}
      {approved ? (
        <ul className="mt-2 flex flex-col gap-1">
          {notice.roster.map((seat) => {
            const label = seat.agentId;
            const failure = notice.failures.find((entry) => entry.seat === seat.seat) ?? null;
            return (
              <li key={seat.seat}>
                <button
                  type="button"
                  disabled={environmentId === undefined}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-hidden hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => openSeat(seat.threadId)}
                >
                  <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                    {seat.seat}
                  </Badge>
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="truncate text-foreground">{label}</span>}
                    />
                    <TooltipPopup>{seat.participantId}</TooltipPopup>
                  </Tooltip>
                  {seat.isNew ? (
                    <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                      New
                    </span>
                  ) : null}
                  {seat.start === "failed" ? (
                    <span className="ms-auto shrink-0 rounded-md bg-red-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-red-700 dark:text-red-300">
                      Failed to start
                    </span>
                  ) : seat.start === "pending" ? (
                    <span className="ms-auto shrink-0 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300">
                      Start unconfirmed
                    </span>
                  ) : null}
                </button>
                {failure !== null ? (
                  <p className="ps-1.5 text-xs text-muted-foreground">{failure.detail}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : notice.requestedSeats.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Requested:{" "}
          {notice.requestedSeats.map((seat) => `${seat.seat} (${seat.agentId})`).join(", ")}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">{crewGateFooter(notice)}</p>
    </section>
  );
}

/** Null for anything that is not a Crew notice; the caller then falls through to its own rendering. */
export function renderCrewNotice(input: CrewNoticeRenderInput): ReactNode {
  const notice = presentCrewNotice(input.message);
  if (notice === null) return null;
  return notice.kind === "launch" ? (
    <CrewLaunchCard notice={notice} input={input} />
  ) : (
    <CrewGateCard notice={notice} input={input} />
  );
}
