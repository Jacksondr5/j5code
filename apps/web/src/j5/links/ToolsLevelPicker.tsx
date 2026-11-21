import { AuthMcpClientAccess } from "@t3tools/contracts";

import { accessConfig } from "../../components/auth/ConnectAgentSurface";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import type { ToolsLevel } from "./linkPairs";

const LEVELS: ReadonlyArray<ToolsLevel> = ["off", ...AuthMcpClientAccess.literals];

export const toolsLevelLabel = (level: ToolsLevel) =>
  level === "off" ? "Off" : accessConfig[level].label;

const describe = (level: ToolsLevel, holder: string, other: string) =>
  level === "off"
    ? `Messages only. ${holder}'s agents can't use tools on ${other}.`
    : level === "full-access"
      ? `${accessConfig[level].description} Also needed to start Peer Agents on ${other} and act on ${other}'s own threads.`
      : accessConfig[level].description;

/** What one server's agents may do on the other: Off, then upstream's access levels. */
export function ToolsLevelPicker({
  value,
  holder,
  other,
  disabled = false,
  onlyOff = false,
  withoutOff = false,
  onChange,
}: {
  readonly value: ToolsLevel;
  /** The server whose agents the level is for, and the server they would act on. */
  readonly holder: string;
  readonly other: string;
  readonly disabled?: boolean;
  /** Raising a level needs something this client cannot do; turning it off does not. */
  readonly onlyOff?: boolean;
  /** The level is being asked for, so Off is not one of the answers. */
  readonly withoutOff?: boolean;
  readonly onChange: (level: ToolsLevel) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null && next !== value) onChange(next as ToolsLevel);
      }}
    >
      <SelectTrigger size="xs" className="w-40" aria-label={`${holder}'s agents on ${other}`}>
        <SelectValue>{toolsLevelLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {LEVELS.filter((level) => !withoutOff || level !== "off").map((level) => (
          <SelectItem
            key={level}
            value={level}
            disabled={onlyOff && level !== "off" && level !== value}
            hideIndicator
          >
            <span className="grid max-w-72 min-w-0 gap-0.5 py-0.5">
              <span className="font-medium text-foreground">{toolsLevelLabel(level)}</span>
              <span className="text-xs leading-4 text-muted-foreground">
                {describe(level, holder, other)}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
