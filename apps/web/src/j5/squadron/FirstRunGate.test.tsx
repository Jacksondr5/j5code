import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { Button } from "../../components/ui/button";
import { SquadronFirstRunGate } from "./FirstRunGate";

function findRetry(node: ReactNode): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const retry = findRetry(child);
      if (retry !== undefined) return retry;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<{
    readonly children?: ReactNode;
    readonly onClick?: () => void;
  }>;
  if (element.type === Button) return element.props.onClick;
  return findRetry(element.props.children);
}

describe("SquadronFirstRunGate", () => {
  it("offers a retry only when an unavailable directory read can be retried", () => {
    const retry = vi.fn();

    const unavailable = renderToStaticMarkup(
      <SquadronFirstRunGate state="unavailable" onRetry={retry}>
        <div>Ready</div>
      </SquadronFirstRunGate>,
    );
    const loading = renderToStaticMarkup(
      <SquadronFirstRunGate state="loading" onRetry={retry}>
        <div>Ready</div>
      </SquadronFirstRunGate>,
    );

    expect(unavailable).toContain("Try again");
    expect(loading).not.toContain("Try again");
  });

  it("invokes the supplied unavailable-state retry", () => {
    const retry = vi.fn();
    const retryAction = findRetry(
      SquadronFirstRunGate({
        state: "unavailable",
        onRetry: retry,
        children: <div>Ready</div>,
      }),
    );

    expect(retryAction).toBeTypeOf("function");
    retryAction?.();
    expect(retry).toHaveBeenCalledOnce();
  });
});
