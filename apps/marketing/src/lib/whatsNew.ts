/**
 * A What's new page's vignettes: plays each one once when it scrolls into view, and makes the
 * Inbox piece work (links, tabs, the + menu, the panel controls, answering). Without this script
 * the page shows every vignette finished, and hides the hints that need it.
 */
export const select = <T extends Element = HTMLElement>(root: ParentNode, selector: string) =>
  Array.from(root.querySelectorAll<T>(selector));

function playOnceWhenSeen(root: HTMLElement) {
  if (typeof IntersectionObserver === "undefined") return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const follow = () => root.classList.toggle("wn-motion", !reduced.matches);
  follow();
  reduced.addEventListener("change", follow);
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.setAttribute("data-play", "");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
  );
  for (const vignette of select(root, "[data-vignette]")) observer.observe(vignette);
}

/** A thread's + menu. `add` gets the kind of surface the reader picked. */
function wireAddMenu(head: HTMLElement, add: (kind: string) => void, signal: AbortSignal) {
  const button = head.querySelector<HTMLElement>("[data-inbox-plus]");
  const menu = head.querySelector<HTMLElement>('[role="menu"]');
  if (!button || !menu) return;
  const items = () => select(menu, '[role="menuitem"]:not([aria-disabled])');
  const show = (open: boolean) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (!open) return;
    menu.style.setProperty("--x", `${button.offsetLeft}px`);
    items()[0]?.focus();
  };
  button.addEventListener("click", () => show(menu.hidden !== false));
  menu.addEventListener("click", (event) => {
    const item = (event.target as Element).closest<HTMLElement>('[role="menuitem"]');
    if (!item || item.hasAttribute("aria-disabled")) return;
    show(false);
    add(item.dataset.inboxAdd ?? "");
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      // The sheet closes on Escape too; this one only closes the menu.
      event.stopPropagation();
      show(false);
      return button.focus();
    }
    const list = items();
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (step !== 0) {
      event.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLElement);
      return list[(at + step + list.length) % list.length]?.focus();
    }
    list.find((item) => item.dataset.key === event.key.toUpperCase())?.click();
  });
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target as Node;
      if (!menu.hidden && !menu.contains(target) && !button.contains(target)) show(false);
    },
    { signal },
  );
}

function wireInbox(root: HTMLElement, inbox: HTMLElement) {
  // "Start over" swaps this copy in, taken before anything is touched.
  const fresh = inbox.cloneNode(true) as HTMLElement;
  const live = new AbortController();
  const links = select(inbox, "[data-inbox-open]");
  const heads = select(inbox, "[data-inbox-thread]");
  const page = inbox.querySelector<HTMLElement>(".inbox__page");
  const toggle = inbox.querySelector<HTMLElement>("[data-inbox-toggle]");
  const max = inbox.querySelector<HTMLElement>("[data-inbox-max]");
  // Where the vignette stops fitting two columns; the app's own sheet breakpoint is wider.
  const narrow = window.matchMedia("(max-width: 860px)");
  let opener: HTMLElement | null = null;

  const head = () => heads.find((entry) => !entry.hidden);
  const selected = () => head()?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  // In a narrow window the panel is a sheet, and it stays shut until something opens it.
  const sheetOpen = () => narrow.matches && "sheet" in inbox.dataset;
  const panelShown = () => (narrow.matches ? sheetOpen() : inbox.dataset.panel === "open");

  // Shows the selected tab's surface. A link reads as pressed only while its tab shows.
  const settle = () => {
    const surface = selected()?.dataset.inboxTab;
    for (const entry of select(inbox, "[data-inbox-surface]"))
      entry.hidden = entry.dataset.inboxSurface !== surface;
    // One tab stop per strip: Tab reaches the selected tab, and the arrows move between tabs.
    for (const tab of select(inbox, '[role="tab"]'))
      tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1;
    const shown = panelShown();
    for (const link of links)
      link.setAttribute("aria-pressed", String(shown && link.dataset.inboxOpen === surface));
    toggle?.setAttribute("aria-pressed", String(shown));
    const maxed = "max" in inbox.dataset;
    max?.setAttribute("aria-pressed", String(maxed));
    max?.setAttribute("aria-label", maxed ? "Restore panel size" : "Maximize panel");
    if (page) page.inert = sheetOpen();
  };
  const pick = (tab: HTMLElement) => {
    for (const other of select(tab.parentElement ?? tab, '[role="tab"]'))
      other.setAttribute("aria-selected", String(other === tab));
    settle();
  };
  const open = (from: HTMLElement | null) => {
    opener = from;
    inbox.dataset.panel = "open";
    inbox.dataset.sheet = "";
    settle();
    if (!sheetOpen()) return;
    // The sheet covers the questions: bring it into view and put focus on its way out.
    inbox.scrollIntoView({ block: "start" });
    toggle?.focus({ preventScroll: true });
  };
  const close = () => {
    const wasSheet = sheetOpen();
    // The panel's entrance is over once the reader has shut it; reopening must not replay it.
    inbox.querySelector(".inbox__panel")?.classList.remove("seq");
    inbox.dataset.panel = "closed";
    delete inbox.dataset.sheet;
    delete inbox.dataset.max;
    settle();
    // A sheet hands focus back to what opened it, unless answering has taken that away.
    if (wasSheet) (opener?.offsetParent ? opener : toggle)?.focus();
  };

  for (const link of links) {
    link.addEventListener("click", () => {
      for (const entry of heads)
        entry.hidden = entry.dataset.inboxThread !== link.dataset.inboxOpen;
      const tab = head()?.querySelector<HTMLElement>(
        `[data-inbox-tab="${link.dataset.inboxOpen}"]`,
      );
      if (tab) pick(tab);
      open(link);
    });
  }
  for (const tab of select(inbox, '[role="tab"]')) tab.addEventListener("click", () => pick(tab));
  for (const strip of select(inbox, '[role="tablist"]')) {
    strip.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step === 0) return;
      // Only the tabs that are open take part; a surface not added yet is not a stop.
      const tabs = select(strip, '[role="tab"]').filter((tab) => !tab.hidden);
      const at = tabs.indexOf(document.activeElement as HTMLElement);
      const next = tabs[(at + step + tabs.length) % tabs.length];
      if (!next) return;
      event.preventDefault();
      pick(next);
      next.focus();
    });
  }
  for (const entry of heads) {
    wireAddMenu(
      entry,
      (kind) => {
        const tab = entry.querySelector<HTMLElement>(`[role="tab"][data-kind="${kind}"]`);
        if (!tab) return;
        // A surface that isn't open yet joins the end of the strip.
        if (tab.hidden) tab.parentElement?.append(tab);
        tab.hidden = false;
        pick(tab);
        tab.focus();
      },
      live.signal,
    );
  }
  toggle?.addEventListener("click", () => (panelShown() ? close() : open(toggle)));
  max?.addEventListener("click", () => {
    inbox.toggleAttribute("data-max");
    settle();
  });

  inbox.addEventListener("click", (event) => {
    (event.target as Element).closest("[data-hot]")?.removeAttribute("data-hot");
  });
  // An app window keeps its size when an ask collapses or leaves; so does this one.
  inbox.addEventListener(
    "click",
    () => {
      inbox.style.minHeight = `${inbox.offsetHeight}px`;
    },
    { capture: true, once: true },
  );
  inbox.addEventListener("keydown", (event) => {
    if (!sheetOpen()) return;
    if (event.key === "Escape") return close();
    if (event.key !== "Tab") return;
    // The sheet is modal, so Tab goes round what it shows and never to the page behind it.
    const stops = select(inbox, "button, summary").filter(
      (stop) => stop.offsetParent !== null && stop.tabIndex >= 0 && !stop.closest("[inert]"),
    );
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length];
    event.preventDefault();
    next?.focus({ preventScroll: true });
  });
  narrow.addEventListener(
    "change",
    () => {
      // This runs before the narrow layout hides anything, so focus is still where it was.
      const active = document.activeElement;
      const inPanel =
        active instanceof HTMLElement &&
        inbox.contains(active) &&
        (active === max || active.closest(".inbox__panel") !== null);
      inbox.style.minHeight = "";
      settle();
      // Narrowing puts a sheet over what held focus, or hides the panel that held it.
      if (sheetOpen() || (narrow.matches && inPanel)) toggle?.focus({ preventScroll: true });
    },
    { signal: live.signal },
  );

  const shelf = inbox.querySelector<HTMLElement>("[data-inbox-shelf]");
  const tally = () => {
    const waiting = select(inbox, "[data-inbox-ask]").filter((ask) => !ask.hidden).length;
    const answered = select(inbox, "[data-inbox-answered]").filter((row) => !row.hidden).length;
    const write = (selector: string, text: string) => {
      const target = inbox.querySelector(selector);
      if (target) target.textContent = text;
    };
    write("[data-inbox-count]", `${waiting} question${waiting === 1 ? "" : "s"} open`);
    write("[data-inbox-answered-count]", String(answered));
    const empty = inbox.querySelector<HTMLElement>("[data-inbox-empty]");
    if (empty) empty.hidden = waiting > 0;
    if (shelf) shelf.hidden = answered === 0;
  };
  for (const ask of select(inbox, "[data-inbox-ask]")) {
    const reply = ask.querySelector<HTMLTextAreaElement>("[data-inbox-reply]");
    const answer = ask.querySelector<HTMLButtonElement>("[data-inbox-answer]");
    if (!reply || !answer) continue;
    // Answer is available once there is something to send, as in the app.
    const follow = () => {
      answer.disabled = reply.value.trim().length === 0;
    };
    reply.addEventListener("input", follow);
    follow();
    answer.addEventListener("click", () => {
      const row = inbox.querySelector<HTMLElement>(
        `[data-inbox-answered="${ask.dataset.inboxAsk}"]`,
      );
      ask.hidden = true;
      if (row) {
        row.hidden = false;
        row.parentElement?.prepend(row);
      }
      tally();
      // The button that held focus is gone; the shelf it moved to is the next stop.
      shelf?.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    });
  }

  settle();
  root.querySelector("[data-inbox-reset]")?.addEventListener(
    "click",
    () => {
      live.abort();
      // The copy was taken before the vignette first played, so it has to be told it has.
      fresh.setAttribute("data-play", "");
      inbox.replaceWith(fresh);
      wireInbox(root, fresh);
    },
    { once: true },
  );
}

export function startWhatsNew(root: HTMLElement) {
  root.setAttribute("data-live", "");
  playOnceWhenSeen(root);
  for (const inbox of select(root, "[data-inbox]")) wireInbox(root, inbox);
}
