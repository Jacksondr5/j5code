import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { Badge } from "../../components/ui/badge";
import { Radio, RadioGroup } from "../../components/ui/radio-group";
import { readPreparedConnection } from "../../state/session";
import { runPeeringCheck, type PeeringCheck } from "../peering/peeringCheck";
import { OriginField } from "../peering/peeringParts";
import {
  routeWording,
  type LinkSetupServer,
  type PairEdits,
  type PairRoute,
  type RouteOption,
} from "./linkSetup";

const clientUrlOf = (environmentId: EnvironmentId) =>
  readPreparedConnection(environmentId)?.httpBaseUrl ?? null;

/**
 * What each of `remotes` and `local` found when asked to reach the other, by the remote's id;
 * a pair still being checked has no entry. Each pair is checked once, and nothing is recorded.
 */
export function usePairChecks(
  local: LinkSetupServer | null,
  remotes: ReadonlyArray<LinkSetupServer>,
): Readonly<Record<string, PeeringCheck>> {
  const [checks, setChecks] = useState<Readonly<Record<string, PeeringCheck>>>({});
  const started = useRef(new Set<string>());
  const localId = local?.environmentId ?? null;
  const prefix = `${localId ?? ""}|`;
  const wanted = remotes.map((remote) => remote.environmentId).join(",");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the two servers of each pair how they reach each other when the pair is first chosen
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Keyed on the ids: the server objects are rebuilt on every environment refresh.
    if (local === null) return;
    for (const remote of remotes) {
      const key = `${prefix}${remote.environmentId}`;
      if (started.current.has(key)) continue;
      started.current.add(key);
      void runPeeringCheck(
        { server: local, clientUrl: clientUrlOf(local.environmentId) },
        { server: remote, clientUrl: clientUrlOf(remote.environmentId) },
      ).then((result) => setChecks((current) => ({ ...current, [key]: result })));
    }
  }, [prefix, wanted]);
  return Object.fromEntries(
    Object.entries(checks).flatMap(([key, check]) =>
      key.startsWith(prefix) ? [[key.slice(prefix.length), check]] : [],
    ),
  );
}

/**
 * Change, for one pair: the ways its messages can travel, the check's pick marked, and an
 * address field only where the check could not prove one.
 */
export function PairRouteChange({
  local,
  remote,
  route,
  onEdits,
  disabled,
}: {
  readonly local: LinkSetupServer;
  readonly remote: LinkSetupServer;
  readonly route: PairRoute;
  readonly onEdits: (edits: PairEdits) => void;
  readonly disabled: boolean;
}) {
  const labelId = useId();
  const chosen: RouteOption | undefined = route.options.find(
    (option) => option.connections === route.choice?.connections,
  );
  return (
    <div className="space-y-2">
      <p id={labelId} className="text-xs font-medium text-foreground">
        How messages travel
      </p>
      <RadioGroup
        aria-labelledby={labelId}
        value={route.choice?.connections ?? null}
        disabled={disabled}
        onValueChange={(next) => {
          const option = route.options.find((candidate) => candidate.connections === next);
          if (option !== undefined) onEdits({ connections: option.connections });
        }}
      >
        {route.options.map((option) => {
          const wording = routeWording(option.connections, local, remote);
          return (
            <label
              key={option.connections}
              className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground"
            >
              <Radio value={option.connections} />
              <span className="text-pretty">
                <span className="text-foreground">{wording.title}</span> · {wording.when}
              </span>
              {option.recommended ? (
                <Badge variant="success" size="sm">
                  Recommended
                </Badge>
              ) : null}
            </label>
          );
        })}
      </RadioGroup>
      {route.choice === null || chosen === undefined
        ? null
        : chosen.asks.map((field) => (
            <OriginField
              key={field}
              title={
                field === "remoteOrigin"
                  ? `${local.label} reaches ${remote.label} at`
                  : `${remote.label} reaches ${local.label} at`
              }
              value={route.choice?.[field] ?? ""}
              error={
                (route.choice?.[field] ?? "").trim() === ""
                  ? "The check couldn't find this address. Enter it to link."
                  : null
              }
              onChange={(value) => onEdits({ [field]: value })}
              disabled={disabled}
            />
          ))}
    </div>
  );
}
