/**
 * The upstream roundup's vignettes: the hero story's replay, tracker tabs, issue rows and the
 * thread picker, the language and voice pickers, port forwarding and the switch.
 */
import { select } from "./whatsNew";

function pressOnly(buttons: ReadonlyArray<HTMLElement>, pressed: HTMLElement, attribute: string) {
  for (const button of buttons) button.setAttribute(attribute, String(button === pressed));
}

interface Locale {
  code: string;
  name: string;
  display: string;
  language: string;
  system: string;
  hint: string;
}

function replay(button: HTMLElement) {
  const vignette = button.closest<HTMLElement>("[data-vignette]");
  if (!vignette) return;
  vignette.removeAttribute("data-play");
  // Reading layout restarts the animations when the attribute returns.
  void vignette.offsetWidth;
  vignette.setAttribute("data-play", "");
}

/** A listbox of buttons: one tab stop, arrows move, and the option's own click selects. */
function wireListbox(options: ReadonlyArray<HTMLElement>, onSelect: (option: HTMLElement) => void) {
  const settle = (selected: HTMLElement) => {
    pressOnly(options, selected, "aria-selected");
    for (const option of options) option.tabIndex = option === selected ? 0 : -1;
  };
  const initial = options.find((option) => option.getAttribute("aria-selected") === "true");
  if (initial) settle(initial);
  options.forEach((option, index) => {
    option.addEventListener("click", () => {
      settle(option);
      onSelect(option);
    });
    option.addEventListener("keydown", (event) => {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      const target =
        event.key === "Home"
          ? options[0]
          : event.key === "End"
            ? options.at(-1)
            : step === undefined
              ? undefined
              : options[(index + step + options.length) % options.length];
      if (!target) return;
      event.preventDefault();
      target.focus();
    });
  });
}

function wireIssues(root: HTMLElement) {
  for (const issues of select(root, "[data-issues]")) {
    const tabs = select(issues, "[data-tracker]");
    const rows = select(issues, "[data-issue]");
    const open = (row: HTMLElement) => {
      pressOnly(rows, row, "aria-pressed");
      for (const panel of select(issues, ".issues__panel"))
        panel.hidden = panel.id !== row.dataset.issue;
    };
    for (const tab of tabs) {
      tab.addEventListener("click", () => {
        pressOnly(tabs, tab, "aria-pressed");
        const tracker = tab.dataset.tracker;
        const groups = select(issues, "[data-group]");
        for (const group of groups)
          group.hidden = tracker !== "all" && group.dataset.group !== tracker;
        const selected = rows.find((row) => row.getAttribute("aria-pressed") === "true");
        if (selected?.closest<HTMLElement>("[data-group]")?.hidden) {
          const first = groups
            .find((group) => !group.hidden)
            ?.querySelector<HTMLElement>("[data-issue]");
          if (first) open(first);
        }
      });
    }
    for (const row of rows) row.addEventListener("click", () => open(row));
    wireThreadPicker(issues);
  }
}

/** "Link to thread" on the Issues page opens a thread picker; choosing a thread links the issue. */
function wireThreadPicker(issues: HTMLElement) {
  const dialog = issues.querySelector<HTMLElement>("[data-picker]");
  const search = dialog?.querySelector<HTMLInputElement>("[data-picker-search]");
  if (!dialog || !search) return;
  const threads = select<HTMLButtonElement>(dialog, "[data-thread]");
  let opener: HTMLElement | null = null;

  const linkedOf = (panel: HTMLElement) => (panel.dataset.linked ?? "").split(",").filter(Boolean);
  const close = () => {
    dialog.hidden = true;
    opener?.focus();
    opener = null;
  };
  const empty = dialog.querySelector<HTMLElement>("[data-picker-empty]");
  const choosable = () => threads.filter((thread) => !thread.hidden && !thread.disabled);
  // As in the app's command list, focus stays in the search box and the arrows move a highlight.
  const highlight = (target: HTMLElement | undefined) => {
    for (const thread of threads) thread.setAttribute("aria-selected", String(thread === target));
    if (target) search.setAttribute("aria-activedescendant", target.id);
    else search.removeAttribute("aria-activedescendant");
  };
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    for (const thread of threads)
      thread.hidden = !(thread.textContent ?? "").toLowerCase().includes(query);
    if (empty) empty.hidden = threads.some((thread) => !thread.hidden);
    highlight(choosable()[0]);
  };

  for (const link of select(issues, "[data-link]")) {
    link.addEventListener("click", () => {
      const panel = link.closest<HTMLElement>(".issues__panel");
      if (!panel) return;
      opener = link;
      const linked = linkedOf(panel);
      for (const thread of threads) {
        const isLinked = linked.includes(thread.dataset.thread ?? "");
        thread.disabled = isLinked;
        const mark = thread.querySelector<HTMLElement>(".issues__picked");
        if (mark) mark.hidden = !isLinked;
      }
      search.value = "";
      filter();
      dialog.hidden = false;
      search.focus();
    });
  }
  for (const thread of threads) {
    thread.addEventListener("click", () => {
      const panel = opener?.closest<HTMLElement>(".issues__panel");
      if (!panel) return;
      const linked = [...linkedOf(panel), thread.dataset.thread ?? ""];
      panel.dataset.linked = linked.join(",");
      const count = panel.querySelector<HTMLElement>("[data-linked-count]");
      const number = count?.querySelector<HTMLElement>("[data-linked-number]");
      if (count && number) {
        number.textContent = String(linked.length);
        count.hidden = false;
      }
      close();
    });
  }
  search.addEventListener("input", filter);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return close();
    // The dialog is modal: Tab stays on its one field.
    if (event.key === "Tab") {
      event.preventDefault();
      return search.focus();
    }
    const options = choosable();
    const active = options.findIndex((thread) => thread.getAttribute("aria-selected") === "true");
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (event.key !== "Enter" && step === undefined) return;
    // Enter must not also press the button that focus returns to when the dialog closes.
    event.preventDefault();
    if (step === undefined) return options[active]?.click();
    if (options.length > 0) highlight(options[(active + step + options.length) % options.length]);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
}

function wireLanguage(root: HTMLElement) {
  for (const picker of select(root, "[data-language]")) {
    const locales = JSON.parse(picker.dataset.locales ?? "[]") as ReadonlyArray<Locale>;
    wireListbox(select(picker, "[data-locale]"), (option) => {
      const locale = locales.find((entry) => entry.code === option.dataset.locale);
      if (!locale) return;
      const text: Record<string, string> = {
        display: locale.display,
        language: locale.language,
        hint: locale.hint,
        system: locale.system,
        current: "system" in option.dataset ? locale.system : locale.name,
      };
      for (const node of select(picker, "[data-t]")) {
        node.textContent = text[node.dataset.t ?? ""] ?? node.textContent;
        node.lang = locale.code;
      }
      const word = picker.querySelector<HTMLElement>("[data-word]");
      if (word) {
        word.classList.remove("is-swapped");
        void word.offsetWidth;
        word.classList.add("is-swapped");
      }
    });
  }
}

function wireVoice(root: HTMLElement) {
  for (const voice of select(root, "[data-voice]")) {
    const value = voice.querySelector<HTMLElement>("[data-voice-value]");
    if (!value) continue;
    wireListbox(select(voice, "[data-voice-option]"), (option) => {
      const icon = option.querySelector("svg, img")?.cloneNode(true);
      const label = document.createElement("span");
      label.textContent = option.dataset.voiceOption ?? "";
      value.replaceChildren(...(icon ? [icon] : []), label);
      const via = option.dataset.voiceVia;
      if (via) {
        const note = document.createElement("small");
        note.textContent = ` via ${via}`;
        label.append(note);
      }
    });
  }
}

function wireServers(root: HTMLElement) {
  for (const button of select(root, "[data-servers] [data-forward]")) {
    button.addEventListener("click", () => {
      const forwarded = button.getAttribute("aria-pressed") !== "true";
      const port = button.dataset.port;
      button.setAttribute("aria-pressed", String(forwarded));
      button.setAttribute(
        "aria-label",
        forwarded
          ? `Stop forwarding localhost:${port}`
          : `Forward localhost:${port} to this machine`,
      );
      button.dataset.tip = forwarded
        ? `Forwarded to localhost:${port} on this machine. Click to stop.`
        : "Forward to this machine, for any app here";
      button.closest<HTMLElement>("li")?.setAttribute("data-forwarded", String(forwarded));
    });
  }
}

export function startRoundup(root: HTMLElement) {
  wireIssues(root);
  wireLanguage(root);
  wireVoice(root);
  wireServers(root);
  for (const button of select(root, "[data-replay]"))
    button.addEventListener("click", () => replay(button));
  for (const toggle of select(root, "[data-switch]")) {
    toggle.addEventListener("click", () => {
      toggle.setAttribute("aria-checked", String(toggle.getAttribute("aria-checked") !== "true"));
    });
  }
}
