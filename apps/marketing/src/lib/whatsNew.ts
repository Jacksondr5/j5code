/**
 * A What's new page's vignettes: plays each one once when it scrolls into view, and wires the
 * Inbox piece's links, panel and reply boxes. Without this script the page shows every vignette
 * finished, and hides the hints that need it.
 */
const select = <T extends Element = HTMLElement>(root: ParentNode, selector: string) =>
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

function wireInbox(root: HTMLElement) {
  for (const inbox of select(root, "[data-inbox]")) {
    const links = select(inbox, "[data-inbox-open]");
    const page = inbox.querySelector<HTMLElement>(".inbox__page");
    // Where the vignette stops fitting two columns; the app's own sheet breakpoint is wider.
    const narrow = window.matchMedia("(max-width: 860px)");
    let opener: HTMLElement | null = null;
    const closeButton = () =>
      inbox.querySelector<HTMLElement>("[data-inbox-panel]:not([hidden]) [data-inbox-close]");
    // In a narrow window the panel is a sheet, and it stays shut until a link opens it.
    const sheetOpen = () => narrow.matches && "sheet" in inbox.dataset;
    const panelShown = () => (narrow.matches ? sheetOpen() : inbox.dataset.panel === "open");
    // A link reads as pressed only while its panel shows, and an open sheet is modal.
    const settle = () => {
      const shown = panelShown()
        ? inbox.querySelector<HTMLElement>("[data-inbox-panel]:not([hidden])")?.dataset.inboxPanel
        : undefined;
      for (const link of links)
        link.setAttribute("aria-pressed", String(link.dataset.inboxOpen === shown));
      if (page) page.inert = sheetOpen();
    };
    const close = () => {
      inbox.dataset.panel = "closed";
      delete inbox.dataset.sheet;
      settle();
      opener?.focus();
    };
    for (const link of links) {
      link.addEventListener("click", () => {
        opener = link;
        for (const panel of select(inbox, "[data-inbox-panel]"))
          panel.hidden = panel.dataset.inboxPanel !== link.dataset.inboxOpen;
        inbox.dataset.panel = "open";
        inbox.dataset.sheet = "";
        settle();
        if (!sheetOpen()) return;
        // The sheet covers the questions: bring it into view and put focus on its way out.
        inbox.scrollIntoView({ block: "start" });
        closeButton()?.focus({ preventScroll: true });
      });
    }
    for (const button of select(inbox, "[data-inbox-close]"))
      button.addEventListener("click", close);
    inbox.addEventListener("keydown", (event) => {
      if (!sheetOpen()) return;
      if (event.key === "Escape") return close();
      // The close button is the sheet's one control, so Tab stays on it.
      if (event.key !== "Tab") return;
      event.preventDefault();
      closeButton()?.focus({ preventScroll: true });
    });
    narrow.addEventListener("change", settle);
    settle();
    // Answer is available once there is something to send, as in the app.
    for (const reply of select<HTMLTextAreaElement>(inbox, "[data-inbox-reply]")) {
      const answer = reply.parentElement?.querySelector<HTMLElement>("[data-inbox-answer]");
      const follow = () => answer?.classList.toggle("inbox__answer--off", reply.value.length === 0);
      reply.addEventListener("input", follow);
      follow();
    }
  }
}

export function startWhatsNew(root: HTMLElement) {
  root.setAttribute("data-live", "");
  playOnceWhenSeen(root);
  wireInbox(root);
}
