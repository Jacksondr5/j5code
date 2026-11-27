import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  AccessRequest,
  BoundAccount,
  JoinedConnect,
  PeopleEntry,
  PersonLevel,
  PersonScope,
} from "@t3tools/contracts/j5";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useState } from "react";

import { ITEM_ROW_CLASSNAME } from "../../components/settings/itemRows";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { toastManager } from "../../components/ui/toast";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { identityManage, identityQuery, refreshIdentity } from "./identityManage";
import { joinAddresses } from "./signIn.logic";
import { levelLabel, raisesToWriting } from "./people.logic";
import { WritingWarning } from "./ShareDialog";
import { peopleQuery, refreshSharing, refusalMessage } from "./sharingManage";

const ROW_NOTE_CLASSNAME = `${ITEM_ROW_CLASSNAME} text-xs text-muted-foreground`;
const LEVELS: ReadonlyArray<PersonLevel> = ["viewer", "collaborator", "owner"];

/** Runs one change, says so plainly when the server refuses, and reads people and sign-in again. */
function changeRunner(environmentId: EnvironmentId) {
  return async (
    title: string,
    run: () => Promise<{ readonly _tag: string; readonly cause?: unknown }>,
  ) => {
    const result = await run();
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title,
        description: refusalMessage(result as Parameters<typeof refusalMessage>[0]),
      });
    }
    refreshIdentity(environmentId);
    refreshSharing(environmentId);
    return result._tag === "Success";
  };
}

const accountLabel = (account: { readonly name: string | null; readonly email: string | null }) =>
  account.email ?? account.name ?? "An account with no name or email";

/**
 * Accounts that signed in through J5 Connect and are no one here yet (design decision 4). An
 * Owner lets one in as a new person, says it is someone already here, or declines it.
 */
export function AccessRequestsSection({
  environmentId,
  people,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly people: ReadonlyArray<PeopleEntry>;
  readonly nowMs: number;
}) {
  const identity = useEnvironmentQuery(identityQuery(environmentId));
  const server = useEnvironment(environmentId)?.label ?? "this server";
  const requests = identity.data?.requests ?? [];
  if (requests.length === 0) return null;
  const bound = new Set((identity.data?.accounts ?? []).map((account) => account.personId));
  const unbound = people.filter((person) => !bound.has(person.personId));
  return (
    <SettingsSection
      title={`Waiting to be let in to ${server}`}
      description="These accounts signed in through J5 Connect. Signing in never adds anyone: let each one in, or say who they are. A name or email from J5 Connect isn't proof of who someone is, so check with them first."
    >
      {requests.map((request) => (
        <RequestRow
          key={request.accountId}
          environmentId={environmentId}
          server={server}
          request={request}
          unbound={unbound}
          nowMs={nowMs}
        />
      ))}
    </SettingsSection>
  );
}

/** The same requests in the Inbox, one section for each server this person owns that has some. */
export function InboxAccessRequests({
  waiting,
}: {
  readonly waiting: ReadonlyArray<{ readonly environmentId: EnvironmentId }>;
}) {
  return waiting.map((entry) => (
    <InboxAccessRequestsFor key={entry.environmentId} environmentId={entry.environmentId} />
  ));
}

function InboxAccessRequestsFor({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const people = useEnvironmentQuery(peopleQuery(environmentId));
  const nowMs = Date.parse(useNowMinute());
  return (
    <div className="mt-6">
      <AccessRequestsSection
        environmentId={environmentId}
        people={people.data?.people ?? []}
        nowMs={nowMs}
      />
    </div>
  );
}

function RequestRow({
  environmentId,
  server,
  request,
  unbound,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly server: string;
  readonly request: AccessRequest;
  readonly unbound: ReadonlyArray<PeopleEntry>;
  readonly nowMs: number;
}) {
  const change = changeRunner(environmentId);
  const bind = useAtomCommand(identityManage.bind, { reportFailure: false });
  const decline = useAtomCommand(identityManage.decline, { reportFailure: false });
  const canBind = useAtomValue(identityManage.bind.permissionAtom(environmentId));
  const canGrant = useAtomValue(identityManage.grant.permissionAtom(environmentId));
  const canDecline = useAtomValue(identityManage.decline.permissionAtom(environmentId));
  const [letIn, setLetIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const label = accountLabel(request);
  const asked = formatRelativeTimeLabel(DateTime.formatIso(request.requestedAt), nowMs);

  const bindTo = async (personId: string, personName: string | null) => {
    const confirmed = await requestConfirmDialog(
      `Is ${label} ${personName ?? "this person"} on ${server}?`,
      undefined,
      {
        confirmLabel: "Yes, bind",
        content: (
          <p className="text-sm text-muted-foreground">
            From now on this account signs in to {server} as {personName ?? "them"}, on every
            device. Each person has one account, and each account one person.
          </p>
        ),
      },
    );
    if (confirmed !== true) return;
    setBusy(true);
    await change("Could not bind the account", () =>
      bind({ environmentId, input: { accountId: request.accountId, personId } }),
    );
    setBusy(false);
  };

  return (
    <div className={`${ITEM_ROW_CLASSNAME} flex flex-col gap-2`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{request.name ?? label}</p>
          <p className="truncate text-xs text-muted-foreground">
            {request.name !== null && request.email !== null ? `${request.email} · ` : ""}
            asked {asked}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {request.suggested === null ? null : (
            <Button
              size="xs"
              disabled={!canBind || busy}
              onClick={() => void bindTo(request.suggested!.personId, request.suggested!.name)}
            >
              Is this {request.suggested.name}?
            </Button>
          )}
          <Button
            size="xs"
            variant={request.suggested === null ? "default" : "outline"}
            disabled={!canGrant || busy}
            onClick={() => setLetIn((open) => !open)}
          >
            Let in…
          </Button>
          {unbound.length === 0 ? null : (
            <Select
              value={null}
              onValueChange={(personId) => {
                const person = unbound.find((entry) => entry.personId === personId);
                if (person !== undefined) void bindTo(person.personId, person.name);
              }}
            >
              <SelectTrigger
                size="xs"
                aria-label="Someone already here"
                disabled={!canBind || busy}
              >
                <SelectValue>Someone already here…</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {unbound.map((person) => (
                  <SelectItem hideIndicator key={person.personId} value={person.personId}>
                    {person.name ?? "Someone without a name yet"}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!canDecline || busy}
            onClick={() => {
              setBusy(true);
              void change("Could not decline the request", () =>
                decline({ environmentId, input: { accountId: request.accountId } }),
              ).then(() => setBusy(false));
            }}
          >
            Decline
          </Button>
        </div>
      </div>
      {letIn ? (
        <LetInForm
          environmentId={environmentId}
          server={server}
          request={request}
          onDone={() => setLetIn(false)}
        />
      ) : null}
    </div>
  );
}

function LetInForm({
  environmentId,
  server,
  request,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly server: string;
  readonly request: AccessRequest;
  readonly onDone: () => void;
}) {
  const change = changeRunner(environmentId);
  const grant = useAtomCommand(identityManage.grant, { reportFailure: false });
  const canGrant = useAtomValue(identityManage.grant.permissionAtom(environmentId));
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.isScratch !== true,
  );
  const [name, setName] = useState(request.name ?? "");
  const [where, setWhere] = useState<string>("server");
  const [level, setLevel] = useState<PersonLevel>("viewer");
  const [busy, setBusy] = useState(false);
  const levels = where === "server" ? LEVELS : LEVELS.filter((entry) => entry !== "owner");
  const scope: PersonScope =
    where === "server" ? { kind: "server" } : { kind: "project", projectId: where as ProjectId };

  const submit = async () => {
    setBusy(true);
    const done = await change("Could not let the account in", () =>
      grant({
        environmentId,
        input: { accountId: request.accountId, name: name.trim(), scope, level },
      }),
    );
    setBusy(false);
    if (done) onDone();
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-48">
          <Input
            size="sm"
            aria-label="Name"
            placeholder="Their name here"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <Select
          value={where}
          onValueChange={(next) => {
            setWhere(next ?? "server");
            if (next !== "server" && level === "owner") setLevel("collaborator");
          }}
        >
          <SelectTrigger size="sm" aria-label="Where">
            <SelectValue>
              {where === "server"
                ? `All of ${server}`
                : (projects.find((project) => project.id === where)?.title ?? "A project")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="server">
              All of {server}
            </SelectItem>
            {projects.map((project) => (
              <SelectItem hideIndicator key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select value={level} onValueChange={(next) => setLevel(next as PersonLevel)}>
          <SelectTrigger size="sm" aria-label="Level">
            <SelectValue>{levelLabel(level)}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {levels.map((entry) => (
              <SelectItem hideIndicator key={entry} value={entry}>
                {levelLabel(entry)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          disabled={!canGrant || busy || name.trim() === ""}
          onClick={() => void submit()}
        >
          Let in
        </Button>
      </div>
      {raisesToWriting(null, level) ? <WritingWarning name={name} /> : null}
      <p className="text-xs text-muted-foreground">They sign in again to start using {server}.</p>
    </div>
  );
}

/**
 * The J5 Connect this server trusts and who signs in through it (design decisions 1, 5, 6):
 * join or leave it, and unbind an account. For Owners.
 */
export function SignInSection({
  environmentId,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly nowMs: number;
}) {
  const identity = useEnvironmentQuery(identityQuery(environmentId));
  return (
    <SettingsSection
      title="Sign-in"
      description="People sign in through a J5 Connect this server trusts, instead of being sent a pairing link. Whoever runs that J5 Connect can sign in as anyone here."
    >
      {identity.data === null ? (
        <p className={ROW_NOTE_CLASSNAME}>{identity.error ?? "Reading sign-in…"}</p>
      ) : identity.data.connect === null ? (
        <JoinForm environmentId={environmentId} />
      ) : (
        <Joined
          environmentId={environmentId}
          connect={identity.data.connect}
          accounts={identity.data.accounts}
          nowMs={nowMs}
        />
      )}
    </SettingsSection>
  );
}

function JoinForm({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const change = changeRunner(environmentId);
  const join = useAtomCommand(identityManage.join, { reportFailure: false });
  const canJoin = useAtomValue(identityManage.join.permissionAtom(environmentId));
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const prepared = usePreparedConnection(environmentId);
  const addresses = joinAddresses({
    servesPage: environmentId === primaryEnvironmentId,
    pageHref: window.location.href,
    reachedAt: Option.isSome(prepared)
      ? { route: prepared.value.target._tag, httpBaseUrl: prepared.value.httpBaseUrl }
      : null,
  });
  const redirects = useEnvironmentQuery(
    identityManage.returnUrls({ environmentId, input: { addresses } }),
  );
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    await change("Could not join J5 Connect", () =>
      join({
        environmentId,
        input: {
          issuer: issuer.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          addresses,
        },
      }),
    );
    setBusy(false);
  };

  return (
    <div className={`${ITEM_ROW_CLASSNAME} flex flex-col gap-3`}>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">1. Register this server with J5 Connect</p>
        <p className="text-xs text-muted-foreground">
          Its operator adds a client for this server, with a client id, a secret and these redirect
          URIs:
        </p>
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
          {(redirects.data?.returnUrls ?? []).map((url) => (
            <li key={url} className="break-all">
              {url}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">2. Join it</p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex w-64">
            <Input
              size="sm"
              aria-label="J5 Connect address"
              placeholder="https://connect.example.com"
              value={issuer}
              onChange={(event) => setIssuer(event.currentTarget.value)}
            />
          </div>
          <div className="flex w-40">
            <Input
              size="sm"
              aria-label="Client id"
              placeholder="Client id"
              value={clientId}
              onChange={(event) => setClientId(event.currentTarget.value)}
            />
          </div>
          <div className="flex w-48">
            <Input
              size="sm"
              type="password"
              autoComplete="new-password"
              aria-label="Client secret"
              placeholder="Client secret"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.currentTarget.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={
              !canJoin ||
              busy ||
              issuer.trim() === "" ||
              clientId.trim() === "" ||
              clientSecret.trim() === ""
            }
            onClick={() => void submit()}
          >
            {busy ? "Checking…" : "Join"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Joining checks the secret and every redirect URI first, and changes nothing if one is
          missing.
        </p>
      </div>
    </div>
  );
}

function Joined({
  environmentId,
  connect,
  accounts,
  nowMs,
}: {
  readonly environmentId: EnvironmentId;
  readonly connect: JoinedConnect;
  readonly accounts: ReadonlyArray<BoundAccount>;
  readonly nowMs: number;
}) {
  const change = changeRunner(environmentId);
  const leave = useAtomCommand(identityManage.leave, { reportFailure: false });
  const unbind = useAtomCommand(identityManage.unbind, { reportFailure: false });
  const canLeave = useAtomValue(identityManage.leave.permissionAtom(environmentId));
  const canUnbind = useAtomValue(identityManage.unbind.permissionAtom(environmentId));

  const leaveConnect = async () => {
    const confirmed = await requestConfirmDialog(
      `Stop trusting ${new URL(connect.issuer).host}?`,
      { variant: "destructive" },
      {
        confirmLabel: "Leave J5 Connect",
        content: (
          <p className="text-sm text-muted-foreground">
            Every device that signed in through it is signed out, and its requests are dropped.
            People stay on the server with what they reach, and can be sent links.
          </p>
        ),
      },
    );
    if (confirmed !== true) return;
    await change("Could not leave J5 Connect", () => leave({ environmentId, input: {} }));
  };

  const unbindAccount = async (account: BoundAccount) => {
    const confirmed = await requestConfirmDialog(
      `Unbind ${accountLabel(account)} from ${account.personName ?? "this person"}?`,
      { variant: "destructive" },
      {
        confirmLabel: "Unbind",
        content: (
          <p className="text-sm text-muted-foreground">
            The devices that signed in with it are signed out. {account.personName ?? "They"} stay
            on the server, and the account asks to be let in if it signs in again.
          </p>
        ),
      },
    );
    if (confirmed !== true) return;
    await change("Could not unbind the account", () =>
      unbind({ environmentId, input: { personId: account.personId } }),
    );
  };

  return (
    <>
      <div className={`${ITEM_ROW_CLASSNAME} flex flex-wrap items-center justify-between gap-2`}>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">Trusts {new URL(connect.issuer).host}</p>
          <p className="truncate text-xs text-muted-foreground">
            Client {connect.clientId} · signs in at{" "}
            {connect.returnUrls.map((url) => new URL(url).host).join(", ")}
          </p>
        </div>
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={!canLeave}
          onClick={() => void leaveConnect()}
        >
          Leave…
        </Button>
      </div>
      {accounts.length === 0 ? (
        <p className={ROW_NOTE_CLASSNAME}>No one here signs in through it yet.</p>
      ) : (
        accounts.map((account) => (
          <div
            key={account.accountId}
            className={`${ITEM_ROW_CLASSNAME} flex flex-wrap items-center justify-between gap-2`}
          >
            <div className="min-w-0">
              <p className="truncate text-sm">
                {account.personName ?? "Someone without a name yet"}
                <span className="text-muted-foreground"> · {accountLabel(account)}</span>
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {account.lastConfirmedAt === null
                  ? "Not signed in through it yet"
                  : `Confirmed ${formatRelativeTimeLabel(DateTime.formatIso(account.lastConfirmedAt), nowMs)}`}
              </p>
            </div>
            <Button
              size="xs"
              variant="outline"
              disabled={!canUnbind}
              onClick={() => void unbindAccount(account)}
            >
              Unbind…
            </Button>
          </div>
        ))
      )}
    </>
  );
}
