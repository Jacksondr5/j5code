import { isPlaybookThread, type PlaybookThreadParent } from "@j5/playbook-contracts/sidebar";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { readPlaybookThreadParent } from "./client";

export function PlaybookThreadBanner({
  environmentId,
  threadId,
}: {
  environmentId: string;
  threadId: string;
}) {
  const [parent, setParent] = useState<PlaybookThreadParent | null>(null);
  useEffect(() => {
    let active = true;
    if (!isPlaybookThread(threadId)) return;
    void readPlaybookThreadParent(threadId)
      .then((result) => {
        if (active) setParent(result);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [threadId]);
  if (!parent) return null;
  return (
    <aside className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/50 px-4 py-2 text-sm">
      <span>
        Part of playbook <strong>{parent.title}</strong>
      </span>
      <Link
        className="underline"
        to="/runs"
        search={{ runId: parent.runId, squadronId: parent.squadronId, newPlaybook: undefined }}
        hash="playbook-approval"
      >
        Open playbook
      </Link>
      <span className="sr-only">Environment {environmentId}</span>
    </aside>
  );
}
