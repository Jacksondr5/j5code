import { PlaybookOrigin } from "@t3tools/contracts/j5";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Recovery must use the authority of the turn that originally created the notice.
export const NoticeOrigin = Context.Reference<PlaybookOrigin>("j5/playbooks/NoticeOrigin", {
  defaultValue: () => ({ kind: "unverified" }),
});
const stored = Schema.fromJsonString(PlaybookOrigin);
export const encodeNoticeOrigin = Schema.encodeSync(stored);
export const decodeNoticeOrigin = (value: string | null): PlaybookOrigin =>
  Option.getOrElse(
    Schema.decodeUnknownOption(stored)(value),
    () => ({ kind: "unverified" }) as const,
  );
