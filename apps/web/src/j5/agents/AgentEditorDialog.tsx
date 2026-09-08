import { useAtomValue } from "@effect/atom-react";
import {
  AGENT_PERSONA_POLICY_OPTIONS,
  agentPersonaModelChoices,
  agentPersonaModelChoiceId,
} from "@t3tools/client-runtime/state/agent-personas";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { AgentPersonaEditInput, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPanel,
} from "../../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { orchestrationEnvironment } from "../../state/orchestration";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function AgentEditorDialog(props: {
  environmentId: EnvironmentId;
  initial: AgentPersonaEditInput;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(props.environmentId));
  const choices = agentPersonaModelChoices(providers ?? [], [
    ...props.initial.modelRoute,
    ...draft.modelRoute,
  ]);
  const save = useAtomCommand(orchestrationEnvironment.v2.editImportedAgentPersona, {
    reportFailure: false,
  });
  async function submit() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await save({
        environmentId: props.environmentId,
        input: {
          ...draft,
          displayName: draft.displayName.trim(),
          description: draft.description.trim(),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      props.onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl" showCloseButton={!saving}>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit agent</DialogTitle>
            <DialogDescription>
              Changes apply to this imported copy and future launches. The original file and
              existing tasks stay unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="grid gap-4">
            <label className="grid gap-1.5 text-sm">
              Name
              <Input
                value={draft.displayName}
                required
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
              />
            </label>
            <label className="grid gap-1.5 text-sm">
              Description
              <Textarea
                value={draft.description}
                required
                disabled={saving}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </label>
            <div className="grid gap-1.5 text-sm">
              <span>Runtime policy</span>
              <Select
                value={draft.authorityPolicy}
                disabled={saving}
                onValueChange={(value) => {
                  const policy = AGENT_PERSONA_POLICY_OPTIONS.find((item) => item.value === value);
                  if (policy) setDraft({ ...draft, authorityPolicy: policy.value });
                }}
              >
                <SelectTrigger aria-label="Runtime policy">
                  <SelectValue>
                    {
                      AGENT_PERSONA_POLICY_OPTIONS.find(
                        ({ value }) => value === draft.authorityPolicy,
                      )?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {AGENT_PERSONA_POLICY_OPTIONS.map(({ value, label }) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {draft.modelRoute.map((target, index) => {
              const label = index === 0 ? "Primary model" : "Fallback model";
              const selected = choices.find(({ id }) => id === agentPersonaModelChoiceId(target));
              const updateTarget = (next: typeof target) =>
                setDraft({
                  ...draft,
                  modelRoute:
                    index === 0 ? [next, draft.modelRoute[1]] : [draft.modelRoute[0], next],
                });
              return (
                <div key={label} className="grid gap-2 rounded-lg border p-3">
                  <span className="text-sm font-medium">{label}</span>
                  <Select
                    value={agentPersonaModelChoiceId(target)}
                    disabled={saving}
                    onValueChange={(value) => {
                      const choice = choices.find(({ id }) => id === value);
                      if (choice)
                        updateTarget({
                          ...choice.target,
                          reasoningEffort: choice.efforts.includes(target.reasoningEffort)
                            ? target.reasoningEffort
                            : choice.target.reasoningEffort,
                        });
                    }}
                  >
                    <SelectTrigger aria-label={label}>
                      <SelectValue>{selected?.label}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {choices.map(({ id, label }) => (
                        <SelectItem key={id} value={id}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Select
                    value={target.reasoningEffort}
                    disabled={saving}
                    onValueChange={(value) => {
                      if (value) updateTarget({ ...target, reasoningEffort: value });
                    }}
                  >
                    <SelectTrigger aria-label={`${label} reasoning`}>
                      <SelectValue>{target.reasoningEffort}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {selected?.efforts.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              Model availability and runtime policy support are checked for each launch.
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || !draft.displayName.trim() || !draft.description.trim()}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
