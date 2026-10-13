import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { AuthAccessReadScope, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import type { SharingGrantLevel } from "@t3tools/contracts/j5";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  Link2Icon,
  LogOutIcon,
  SettingsIcon,
  UserPlusIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useProject, useProjects, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildPhysicalToLogicalProjectKeyMap } from "../../sidebarProjectGrouping";
import { ConfirmNameTag } from "./ConfirmNameTag";
import { j5Sharing } from "./guestAccess";
import { removeGrantWarning } from "./people.logic";
import { activeOpenLinkFor, initialsOf, levelLabel, lifetimeLeft } from "./shareLink.logic";
import { openSharingDialog } from "./sharingDialogs";
import {
  openLinksQuery,
  peopleQuery,
  refreshSharing,
  refusalMessage,
  sharingManage,
} from "./sharingManage";
import {
  chipLabel,
  othersLabel,
  sharedWith,
  threadPeopleFrom,
  type Holder,
  type ThreadPeople,
} from "./threadPeople.logic";

function Avatar({ name }: { readonly name: string }) {
  return (
    <span
      aria-hidden
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-4xs font-semibold text-muted-foreground ring-2 ring-background"
    >
      {initialsOf(name)}
    </span>
  );
}

/**
 * Who reaches a thread, for a connection that can read the server's people. A guest's connection
 * cannot, and is told by the server only its own level: it gets `null` here until the server has
 * a request that says who else is on a thread.
 */
function useThreadPeople(environmentId: EnvironmentId, threadId: ThreadId): ThreadPeople | null {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const people = useEnvironmentQuery(canRead ? peopleQuery(environmentId) : null);
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const projectId = thread?.projectId ?? null;
  return useMemo(
    () =>
      people.data === null ? null : threadPeopleFrom(people.data.people, { threadId, projectId }),
    [people.data, projectId, threadId],
  );
}

/**
 * The pill in a thread's header once the thread is shared: who it is shared with, at a glance. It
 * opens the Share dialog for a member who can manage access and is information for anyone else.
 * A thread only members reach shows nothing.
 */
export function ThreadPeopleChip({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const people = useThreadPeople(environmentId, threadId);
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const label = people === null ? null : chipLabel(people);
  if (people === null || label === null) return null;
  const shown = sharedWith(people).slice(0, 3);
  const content = (
    <>
      <span className="flex -space-x-1.5">
        {shown.map(({ person }) => (
          <Avatar key={person.personId} name={person.displayName ?? "?"} />
        ))}
      </span>
      {label}
    </>
  );
  const className =
    "ml-auto flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border pr-2 pl-1 text-xs text-foreground";
  return canManage ? (
    <button
      type="button"
      className={`${className} cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring`}
      aria-label={`Shared with ${label}. Share thread`}
      onClick={() =>
        openSharingDialog({ kind: "share", environmentId, target: { kind: "thread", threadId } })
      }
    >
      {content}
    </button>
  ) : (
    <span className={className} aria-label={`Shared with ${label}`}>
      {content}
    </span>
  );
}

/** The link to a project's settings page, at its Sharing section. */
function useOpenProjectSharing(environmentId: EnvironmentId, threadId: ThreadId) {
  const navigate = useNavigate();
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const project = useProject(
    thread === null ? null : scopeProjectRef(environmentId, thread.projectId),
  );
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return {
    projectTitle: project?.title ?? null,
    open: () => {
      if (project === null) return;
      const projectKey =
        buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId }).get(
          derivePhysicalProjectKey(project),
        ) ?? deriveLogicalProjectKeyFromSettings(project, settings);
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey },
        hash: "project-sharing",
      });
    },
  };
}

/**
 * The People section of a thread's details panel: who holds a grant on the thread, the join link
 * when there is one, and one line for everyone who reaches it some other way. A member who
 * manages access changes it here; anyone else reads it. A guest sees their own place on the
 * thread and the way to leave it (Shared server AC25).
 */
export function ThreadPeopleSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const isGuest = useAtomValue(j5Sharing.isGuest(environmentId));
  return isGuest ? (
    <GuestSection environmentId={environmentId} threadId={threadId} />
  ) : (
    <MemberSection environmentId={environmentId} threadId={threadId} />
  );
}

const ROW_CLASSNAME = "flex min-h-8 items-center gap-2 px-1.5 text-xs";
const MUTED_ROW_CLASSNAME = `${ROW_CLASSNAME} text-muted-foreground`;

function GuestSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const canWrite = useAtomValue(j5Sharing.threadOperable(environmentId, threadId));
  return (
    <ThreadDetailsSection headingId="j5-thread-people-heading" title="People">
      <div className={ROW_CLASSNAME}>
        <Avatar name="You" />
        <span className="min-w-0 flex-1 truncate text-foreground">You</span>
        <span className="text-muted-foreground">{canWrite ? "Collaborate" : "View"}</span>
      </div>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() => openSharingDialog({ kind: "leave", environmentId, threadId })}
      >
        <LogOutIcon className="size-3" />
        Leave this thread
      </Button>
    </ThreadDetailsSection>
  );
}

function MemberSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const canManage = useAtomValue(sharingManage.putGrant.permissionAtom(environmentId));
  const people = useThreadPeople(environmentId, threadId);
  const links = useEnvironmentQuery(canRead ? openLinksQuery(environmentId) : null);
  useEffect(() => {
    if (canRead) refreshSharing(environmentId);
  }, [canRead, environmentId, threadId]);
  const nowMs = Date.parse(useNowMinute());
  const joinLink =
    links.data === null ? null : activeOpenLinkFor(links.data.links, threadId, nowMs);
  const joinLinkLeft =
    joinLink === null ? null : lifetimeLeft(joinLink.expiresAt.epochMilliseconds, nowMs);
  const projectSharing = useOpenProjectSharing(environmentId, threadId);
  const [othersOpen, setOthersOpen] = useState(false);
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const share = () =>
    openSharingDialog({ kind: "share", environmentId, target: { kind: "thread", threadId } });
  const openJoinLink = () => openSharingDialog({ kind: "join-link", environmentId, threadId });

  if (!canRead) return null;
  const others = people === null ? null : othersLabel(people);
  return (
    <ThreadDetailsSection
      headingId="j5-thread-people-heading"
      title="People"
      actions={
        <>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            disabled={!canManage}
            aria-label="Share thread"
            onClick={share}
          >
            <UserPlusIcon className="size-3.5" />
          </Button>
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost-muted" aria-label="More sharing actions" />
              }
            >
              <EllipsisIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {joinLink === null ? (
                <MenuItem disabled={!canManage} onClick={openJoinLink}>
                  Make a join link…
                </MenuItem>
              ) : (
                <MenuItem onClick={openJoinLink}>Join link…</MenuItem>
              )}
              {people !== null && people.throughProject.length > 0 ? (
                <MenuItem onClick={projectSharing.open}>Manage project sharing</MenuItem>
              ) : null}
              <MenuSeparator />
              <MenuItem onClick={() => void navigate({ to: "/settings/people" })}>
                Open People settings
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    >
      {people === null ? (
        <p className={MUTED_ROW_CLASSNAME}>Reading who is on this thread…</p>
      ) : (
        <>
          {people.direct.map((holder) => (
            <HolderRow
              key={holder.person.personId}
              environmentId={environmentId}
              threadTitle={thread?.title ?? "this thread"}
              holder={holder}
              canManage={canManage}
            />
          ))}
          {people.direct.length === 0 && joinLink === null ? (
            <p className={MUTED_ROW_CLASSNAME}>Only members reach this thread.</p>
          ) : null}
          <div className="flex flex-col items-start">
            {joinLink !== null && joinLinkLeft !== null ? (
              <Button size="xs" variant="ghost-muted" onClick={openJoinLink}>
                <Link2Icon className="size-3" />
                Join link · {joinLinkLeft} left
              </Button>
            ) : null}
            {others === null ? null : (
              <Button size="xs" variant="ghost-muted" onClick={() => setOthersOpen(true)}>
                {others}
                <ChevronRightIcon className="size-3" />
              </Button>
            )}
          </div>
          <OthersDialog
            open={othersOpen}
            onClose={() => setOthersOpen(false)}
            people={people}
            projectTitle={projectSharing.projectTitle}
            onOpenPeople={() => void navigate({ to: "/settings/people" })}
            onOpenProjectSharing={projectSharing.open}
          />
        </>
      )}
    </ThreadDetailsSection>
  );
}

function HolderRow({
  environmentId,
  threadTitle,
  holder: { person, grant },
  canManage,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
  readonly holder: Holder;
  readonly canManage: boolean;
}) {
  const name = person.displayName ?? "Unnamed guest";
  const [confirmingName, setConfirmingName] = useState(false);
  const removeGrant = useAtomCommand(sharingManage.removeGrant, { reportFailure: false });

  const remove = async () => {
    const confirmed = await requestConfirmDialog(
      removeGrantWarning(name, threadTitle),
      { variant: "destructive" },
      { confirmLabel: "Remove from thread" },
    );
    if (confirmed !== true) return;
    const result = await removeGrant({
      environmentId,
      input: { personId: person.personId, target: grant.target },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: `Could not remove ${name}`,
        description: refusalMessage(result),
      });
    }
    refreshSharing(environmentId);
  };

  return (
    <div className={ROW_CLASSNAME}>
      <Avatar name={name} />
      <span className="min-w-0 truncate text-foreground">{name}</span>
      {person.nameSelfGiven ? (
        <ConfirmNameTag
          environmentId={environmentId}
          person={person}
          canManage={canManage}
          open={confirmingName}
          onOpenChange={setConfirmingName}
        />
      ) : null}
      <span className="flex-1" />
      {canManage ? (
        <Menu>
          <MenuTrigger
            render={<Button size="xs" variant="outline" aria-label={`Level for ${name}`} />}
          >
            {levelLabel(grant.level)}
            <ChevronDownIcon className="size-3" />
          </MenuTrigger>
          <MenuPopup align="end">
            <LevelItems current={grant.level} />
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                openSharingDialog({
                  kind: "device-link",
                  environmentId,
                  person: { personId: person.personId, name },
                })
              }
            >
              New device link…
            </MenuItem>
            <MenuItem variant="destructive" onClick={() => void remove()}>
              Remove from thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <span className="text-muted-foreground">{levelLabel(grant.level)}</span>
      )}
    </div>
  );
}

/** View and Collaborate as the level menu lists them. Collaborate cannot be chosen yet. */
function LevelItems({ current }: { readonly current: SharingGrantLevel }) {
  return (
    <>
      <MenuItem disabled={current === "view"}>View{current === "view" ? " ✓" : ""}</MenuItem>
      <MenuItem disabled>
        Collaborate
        <Badge variant="outline" size="sm">
          coming soon
        </Badge>
      </MenuItem>
    </>
  );
}

function OthersDialog({
  open,
  onClose,
  people,
  projectTitle,
  onOpenPeople,
  onOpenProjectSharing,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly people: ThreadPeople;
  readonly projectTitle: string | null;
  readonly onOpenPeople: () => void;
  readonly onOpenProjectSharing: () => void;
}) {
  const go = (run: () => void) => () => {
    onClose();
    run();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Others on this thread</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <OthersGroup heading="Members" gearLabel="Open People settings" onGear={go(onOpenPeople)}>
            {people.members.map((member) => (
              <OthersRow key={member.personId} name={member.displayName ?? "Member"} level={null} />
            ))}
          </OthersGroup>
          {people.throughProject.length > 0 ? (
            <OthersGroup
              heading={projectTitle ?? "This thread's project"}
              gearLabel="Manage project sharing"
              onGear={go(onOpenProjectSharing)}
            >
              {people.throughProject.map(({ person, grant }) => (
                <OthersRow
                  key={person.personId}
                  name={person.displayName ?? "Unnamed guest"}
                  level={grant.level}
                />
              ))}
            </OthersGroup>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function OthersGroup({
  heading,
  gearLabel,
  onGear,
  children,
}: {
  readonly heading: string;
  readonly gearLabel: string;
  readonly onGear: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex min-h-6 items-center justify-between">
        <h3 className="min-w-0 truncate text-2xs font-medium text-muted-foreground">{heading}</h3>
        <Button size="icon-xs" variant="ghost-muted" aria-label={gearLabel} onClick={onGear}>
          <SettingsIcon className="size-3.5" />
        </Button>
      </div>
      {children}
    </section>
  );
}

function OthersRow({
  name,
  level,
}: {
  readonly name: string;
  readonly level: SharingGrantLevel | null;
}) {
  return (
    <div className="flex min-h-7.5 items-center gap-2 text-sm">
      <Avatar name={name} />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {level === null ? null : (
        <span className="text-xs text-muted-foreground">{levelLabel(level)}</span>
      )}
    </div>
  );
}
