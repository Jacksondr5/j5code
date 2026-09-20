import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  ServerProvider,
  SkillLinkPreview,
  SkillLinkRequest,
  SkillOrigin,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { skillLinkEnvironment } from "./skillLinkAtoms";

function messageOf(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Unknown request tag: j5.skills.links.")
    ? "This environment's server does not support skill linking yet. Update and restart the app or server hosting this environment, then reconnect."
    : message;
}
export type SkillLinkSelection = {
  readonly source: SkillLinkRequest["source"];
  readonly origin: SkillOrigin;
};
type Props = {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly projectId?: ProjectId;
  readonly projectTitle?: string;
  readonly selection: SkillLinkSelection | null;
  readonly onClose: () => void;
};

export function SkillLinksPanel(props: Props) {
  const links = useEnvironmentQuery(
    props.connected
      ? skillLinkEnvironment.list({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const remove = useAtomCommand(skillLinkEnvironment.remove, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [message, setMessage] = useState("");
  async function unlink(id: string) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await remove({ environmentId: props.environmentId, input: { id } });
      setMessage(
        result._tag === "Success"
          ? result.value.message
          : messageOf(squashAtomCommandFailure(result)),
      );
      links.refresh();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {props.selection ? (
        <LinkSkillDialog
          key={JSON.stringify([props.selection, props.projectId])}
          {...props}
          selection={props.selection}
          onLinked={(message) => {
            setMessage(message);
            links.refresh();
            props.onClose();
          }}
        />
      ) : null}
      <div className="grid gap-2 rounded-xl border border-border/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Managed links</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={!props.connected || busy || links.isPending}
            onClick={() => links.refresh()}
          >
            Refresh links
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Links created here in this environment. Unlink removes only the recorded link; shared
          source files stay in place.
        </p>
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
        {links.error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {messageOf(links.error)}
          </p>
        ) : null}
        {links.data?.map((link) => (
          <div
            key={link.id}
            className="flex min-w-0 items-start justify-between gap-3 border-t pt-2 text-xs"
          >
            <div className="min-w-0 space-y-1 break-words">
              <p className="font-medium">
                {link.skillName} ·{" "}
                {props.providers.find((provider) => provider.instanceId === link.targetInstanceId)
                  ?.displayName ?? link.targetInstanceId}{" "}
                · {link.scope === "user" ? "User" : "Project"}
              </p>
              <p>{link.destinationPath}</p>
              <p>Source: {link.sourcePath}</p>
              <p>
                {link.status === "linked"
                  ? "Link created"
                  : link.status === "broken"
                    ? "Broken link: source or SKILL.md is unavailable. You can still unlink it."
                    : link.status === "missing"
                      ? "Link is missing. Remove its managed record."
                      : "Destination was changed or replaced. It cannot be unlinked here."}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !props.connected || link.status === "changed"}
              onClick={() => void unlink(link.id)}
            >
              {link.status === "missing" ? "Remove record" : "Unlink"}
            </Button>
          </div>
        ))}
        {links.data?.length === 0 ? (
          <p className="text-xs text-muted-foreground">No managed links yet.</p>
        ) : null}
      </div>
    </>
  );
}

export function LinkSkillDialog(
  props: Props & {
    readonly selection: SkillLinkSelection;
    readonly onLinked: (message: string) => void;
  },
) {
  const destinations = props.providers.filter(
    (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
  );
  const [targetId, setTargetId] = useState(
    () =>
      (
        destinations.find((entry) => entry.instanceId !== props.selection.source.instanceId) ??
        destinations[0]
      )?.instanceId,
  );
  const [scope, setScope] = useState<SkillLinkRequest["scope"]>(
    props.selection.origin === "Project" && props.projectId ? "project" : "user",
  );
  const preview = useAtomCommand(skillLinkEnvironment.preview, { reportFailure: false });
  const create = useAtomCommand(skillLinkEnvironment.create, { reportFailure: false });
  const [result, setResult] = useState<{
    request: SkillLinkRequest;
    preview: SkillLinkPreview;
  } | null>(null);
  const [errorState, setError] = useState<{
    request: SkillLinkRequest | null;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const request = useMemo(
    () =>
      targetId && props.connected
        ? {
            source: props.selection.source,
            targetInstanceId: targetId,
            scope,
            ...(props.projectId ? { projectId: props.projectId } : {}),
          }
        : null,
    [props.selection.source, targetId, scope, props.projectId, props.connected],
  );
  useEffect(() => {
    let active = true;
    if (request && props.connected)
      void preview({ environmentId: props.environmentId, input: request }).then((response) => {
        if (!active) return;
        if (response._tag === "Success") setResult({ request, preview: response.value });
        else setError({ request, message: messageOf(squashAtomCommandFailure(response)) });
      });
    return () => {
      active = false;
    };
  }, [request, props.environmentId, props.connected, preview]);
  const checked = result?.request === request ? result.preview : null;
  const error = errorState?.request === request ? errorState.message : "";
  async function link() {
    if (!request || !checked || running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await create({
        environmentId: props.environmentId,
        input: {
          ...request,
          expectedSourcePath: checked.sourcePath,
          expectedDestinationPath: checked.destinationPath,
        },
      });
      if (response._tag === "Success") props.onLinked(response.value.message);
      else {
        setError({ request, message: messageOf(squashAtomCommandFailure(response)) });
        setResult(null);
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Use in…</DialogTitle>
          <DialogDescription>
            Link {props.selection.source.name} to a provider in this environment. The entire skill
            folder stays shared.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-3">
          <label className="grid gap-2 text-sm">
            Destination provider
            <Select
              value={targetId ?? ""}
              disabled={busy}
              onValueChange={(id) =>
                setTargetId(destinations.find((provider) => provider.instanceId === id)?.instanceId)
              }
            >
              <SelectTrigger aria-label="Link destination provider">
                <SelectValue>
                  {destinations.find((provider) => provider.instanceId === targetId)?.displayName ??
                    targetId ??
                    "No Codex or Claude instances"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {destinations.map((provider) => (
                  <SelectItem key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName ?? provider.instanceId} ({provider.instanceId})
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-2 text-sm">
            Scope
            <Select
              value={scope}
              disabled={busy}
              onValueChange={(value) => {
                if (value === "user" || value === "project") setScope(value);
              }}
            >
              <SelectTrigger aria-label="Link scope">
                <SelectValue>
                  {scope === "user" ? "User" : `Project: ${props.projectTitle}`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="project" disabled={!props.projectId}>
                  Project: {props.projectTitle ?? "Select a project first"}
                </SelectItem>
              </SelectPopup>
            </Select>
          </label>
          {checked ? (
            <div className="space-y-2 text-xs break-words">
              <p>
                <strong>Source folder:</strong> {checked.sourcePath}
              </p>
              <p>
                <strong>Destination:</strong> {checked.destinationPath}
              </p>
              {checked.sharedWith.length > 1 ? (
                <p>
                  This destination is shared by{" "}
                  {checked.sharedWith
                    .map((entry) => `${entry.label} (${entry.instanceId})`)
                    .join(", ")}
                  . Linking or unlinking here affects all of them.
                </p>
              ) : null}
              {checked.warnings.map((warning) => (
                <p key={warning} className="text-muted-foreground">
                  {warning}
                </p>
              ))}
              {checked.conflict ? <p role="alert">{checked.conflict}</p> : null}
              {checked.status === "already-linked" ? (
                <p>
                  The same source is already linked. Continuing leaves it unchanged; existing links
                  created elsewhere remain unmanaged.
                </p>
              ) : null}
            </div>
          ) : !error ? (
            <p className="text-sm">
              {props.connected ? "Preparing preview…" : "Environment disconnected."}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || !props.connected || !checked || checked.status === "conflict"}
            onClick={() => void link()}
          >
            {busy ? "Linking…" : "Link skill"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
