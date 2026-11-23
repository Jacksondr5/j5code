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

function pressOnly(buttons: ReadonlyArray<HTMLElement>, pressed: HTMLElement, attribute: string) {
  for (const button of buttons) button.setAttribute(attribute, String(button === pressed));
}

function wireInbox(root: HTMLElement) {
  for (const inbox of select(root, "[data-inbox]")) {
    const links = select(inbox, "[data-inbox-open]");
    const page = inbox.querySelector<HTMLElement>(".inbox__page");
    // Where the vignette stops fitting two columns; the app's own sheet breakpoint is wider.
    const narrow = window.matchMedia("(max-width: 860px)");
    let opener: HTMLElement | null = null;
    for (const link of links) {
      link.addEventListener("click", () => {
        opener = link;
        pressOnly(links, link, "aria-pressed");
        for (const panel of select(inbox, "[data-inbox-panel]"))
          panel.hidden = panel.dataset.inboxPanel !== link.dataset.inboxOpen;
        inbox.dataset.panel = "open";
        // In a narrow window the panel is a sheet, and it stays shut until a link opens it.
        inbox.dataset.sheet = "";
        if (!narrow.matches) return;
        // The sheet covers the questions: bring it into view, and keep focus out from under it.
        if (page) page.inert = true;
        inbox.scrollIntoView({ block: "start" });
        inbox
          .querySelector<HTMLElement>("[data-inbox-panel]:not([hidden]) [data-inbox-close]")
          ?.focus({ preventScroll: true });
      });
    }
    for (const button of select(inbox, "[data-inbox-close]")) {
      button.addEventListener("click", () => {
        inbox.dataset.panel = "closed";
        delete inbox.dataset.sheet;
        if (page) page.inert = false;
        for (const link of links) link.setAttribute("aria-pressed", "false");
        opener?.focus();
      });
    }
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
