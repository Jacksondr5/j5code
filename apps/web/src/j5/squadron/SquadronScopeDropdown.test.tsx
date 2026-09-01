import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../components/ui/menu", () => ({
  Menu: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuItem: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuRadioGroup: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuRadioItem: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
  MenuSeparator: () => null,
  MenuTrigger: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

import { SquadronScopeDropdown } from "./SquadronScopeDropdown";

describe("SquadronScopeDropdown", () => {
  it("keeps the J5 proper noun capitalized in its all-Squadrons option", () => {
    const markup = renderToStaticMarkup(<SquadronScopeDropdown />);

    expect(markup).toContain("All Squadrons");
    expect(markup).not.toContain("All squadrons");
  });
});
