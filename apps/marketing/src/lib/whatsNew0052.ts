/**
 * The 0.0.52 page's pieces: the linked pair's level pickers and Renew, the Crew proposal and its
 * member dialog, the Crews settings, and the Inbox answer with its attachments. Each piece can be
 * put back as it started.
 */
import { select } from "./whatsNew";

type Wire = (piece: HTMLElement, signal: AbortSignal) => void;

const one = <T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string) =>
  root.querySelector<T>(selector);

function later(signal: AbortSignal, ms: number, run: () => void) {
  const timer = window.setTimeout(run, ms);
  signal.addEventListener("abort", () => window.clearTimeout(timer), { once: true });
}

const pickValue = (pick: HTMLElement | null) =>
  pick?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.dataset.value ?? "";

/** Sets a Pick's value without reporting it as a choice. */
function setPick(pick: HTMLElement | null, value: string) {
  if (!pick) return;
  for (const option of select(pick, '[role="option"]')) {
    const chosen = option.dataset.value === value;
    option.setAttribute("aria-selected", String(chosen));
    const label = one(pick, "[data-pick-value]");
    if (chosen && label) label.textContent = option.dataset.label ?? "";
  }
}

/** Opens and closes every Pick in a piece. A choice bubbles from the Pick as a "pick" event. */
function wirePicks(piece: HTMLElement, signal: AbortSignal) {
  const picks = select(piece, "[data-pick]");
  const show = (pick: HTMLElement, open: boolean) => {
    const popup = one(pick, '[role="listbox"]');
    if (!popup || popup.hidden === !open) return;
    popup.hidden = !open;
    one(pick, "[data-pick-trigger]")?.setAttribute("aria-expanded", String(open));
    if (open) (one(popup, '[aria-selected="true"]') ?? one(popup, '[role="option"]'))?.focus();
  };
  for (const pick of picks) {
    const trigger = one(pick, "[data-pick-trigger]");
    const popup = one(pick, '[role="listbox"]');
    if (!trigger || !popup) continue;
    trigger.addEventListener("click", () => {
      const open = popup.hidden !== false;
      for (const other of picks) show(other, false);
      show(pick, open);
    });
    popup.addEventListener("click", (event) => {
      const option = (event.target as Element).closest<HTMLElement>('[role="option"]');
      if (!option) return;
      setPick(pick, option.dataset.value ?? "");
      show(pick, false);
      trigger.focus();
      pick.dispatchEvent(new CustomEvent("pick", { bubbles: true, detail: option.dataset.value }));
    });
    popup.addEventListener("keydown", (event) => {
      if (event.key === "Escape" || event.key === "Tab") {
        // A dialog closes on Escape too; this one only closes the list.
        event.stopPropagation();
        event.preventDefault();
        show(pick, false);
        return trigger.focus();
      }
      const options = select(popup, '[role="option"]');
      const at = options.indexOf(document.activeElement as HTMLElement);
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      const target =
        event.key === "Home"
          ? options[0]
          : event.key === "End"
            ? options.at(-1)
            : step === undefined
              ? undefined
              : options[(at + step + options.length) % options.length];
      if (!target) return;
      event.preventDefault();
      target.focus();
    });
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      for (const pick of picks) if (!pick.contains(event.target as Node)) show(pick, false);
    },
    { signal },
  );
}

const wireLinks: Wire = (piece, signal) => {
  const dot = one(piece, "[data-links-dot]");
  const renew = one<HTMLButtonElement>(piece, "[data-links-renew]");
  const expiry = one(piece, "[data-links-expiry]");
  const hint = one(piece, "[data-links-hint]");
  const picks = select(piece, "[data-pick]");
  const triggers = select<HTMLButtonElement>(piece, "[data-pick-trigger]");
  let days = 4;

  const paint = () => {
    const tools = picks.some((pick) => pickValue(pick) !== "off");
    // The app offers Renew once five days or fewer are left.
    const due = tools && days <= 5;
    const text = `Tool access runs out in ${days} days`;
    if (expiry) {
      expiry.hidden = !tools;
      expiry.textContent = text;
      expiry.dataset.state = due ? "due" : "ok";
    }
    if (hint) hint.hidden = tools;
    if (renew) renew.hidden = !due;
    if (!dot) return;
    dot.dataset.state = due ? "due" : "ok";
    dot.dataset.tip = tools ? text : "Linked";
    dot.setAttribute("aria-label", dot.dataset.tip);
  };

  piece.addEventListener("pick", paint);
  renew?.addEventListener("click", () => {
    renew.disabled = true;
    renew.textContent = "Renewing…";
    for (const trigger of triggers) trigger.disabled = true;
    later(signal, 700, () => {
      days = 30;
      renew.disabled = false;
      renew.textContent = "Renew";
      for (const trigger of triggers) trigger.disabled = false;
      // Renew leaves once it has worked, so focus moves to the next thing in the row.
      if (document.activeElement === renew) triggers[0]?.focus();
      paint();
    });
  });
};

const wireCrewSettings: Wire = (piece) => {
  const chips = select(piece, "[data-chip]");
  const providers = select(piece, "[data-provider]");
  const key = (chip: HTMLElement) =>
    `${chip.closest<HTMLElement>("[data-provider]")?.dataset.provider}:${chip.dataset.chip}:${chip.textContent?.trim()}`;
  const everything = () => new Set(chips.map(key));
  const pressed = (chip: HTMLElement) => chip.getAttribute("aria-pressed") === "true";

  // Each setting has the server's value and, perhaps, one project's own. A list that was never
  // saved is null, and allows everything.
  const auto: { env: boolean; project: boolean | null } = { env: false, project: true };
  const lists: { env: Set<string> | null; project: Set<string> | null } = {
    env: new Set(chips.filter(pressed).map(key)),
    project: null,
  };
  const atProject = () => piece.dataset.scope === "project";
  const autoNow = () => (atProject() ? (auto.project ?? auto.env) : auto.env);
  const listNow = () => (atProject() ? (lists.project ?? lists.env) : lists.env);
  const allowed = (chip: HTMLElement) => listNow()?.has(key(chip)) ?? true;
  const save = (next: Set<string>) => {
    if (atProject()) lists.project = next;
    else lists.env = next;
  };

  const paintMark = (name: string, envSet: boolean, overridden: boolean) => {
    const mark = one(piece, `[data-mark="${name}"]`);
    if (!mark) return;
    const tip = atProject()
      ? overridden
        ? "Overridden for this project"
        : envSet
          ? "Inherited from lighthouse"
          : "Built-in default"
      : `${envSet ? "Set on the environment" : "Built-in default"}${overridden ? " · 1 project override" : ""}`;
    mark.dataset.state = overridden ? (atProject() ? "overridden" : "shown") : "quiet";
    mark.dataset.tip = tip;
    mark.setAttribute("aria-label", tip);
  };
  const paintReset = (name: string, shown: boolean, tip: string) => {
    const reset = one(piece, `[data-reset="${name}"]`);
    if (!reset) return;
    reset.hidden = !shown;
    reset.dataset.tip = atProject() ? "Reset to inherited value" : tip;
  };
  const count = (scope: ParentNode, kind: string) => {
    const of = select(scope, `[data-chip="${kind}"]`);
    return { checked: of.filter(allowed).length, total: of.length };
  };

  const paint = () => {
    one(piece, "[data-auto]")?.setAttribute("aria-checked", String(autoNow()));
    paintMark("auto", auto.env, auto.project !== null);
    paintReset(
      "auto",
      atProject() ? auto.project !== null : auto.env,
      "Reset Crew auto-approval to off",
    );
    paintMark("models", lists.env !== null, lists.project !== null);
    paintReset(
      "models",
      (atProject() ? lists.project : lists.env) !== null,
      "Reset to every model and level",
    );

    for (const chip of chips) chip.setAttribute("aria-pressed", String(allowed(chip)));
    for (const provider of providers) {
      const models = count(provider, "model");
      const levels = count(provider, "level");
      const line = one(provider, "[data-provider-count]");
      if (line)
        line.textContent = `${models.checked} of ${models.total} models · ${levels.checked} of ${levels.total} levels`;
      const all = one(provider, "[data-provider-all]");
      const full = models.checked === models.total && levels.checked === levels.total;
      if (all) all.textContent = full ? "Uncheck all" : "Check all";
    }
    const models = count(piece, "model");
    const total = one(piece, "[data-models-count]");
    if (total) total.textContent = `${models.checked} of ${models.total}`;
    const warning = one(piece, "[data-warning]");
    const text =
      models.checked === 0
        ? "No models allowed, so custom members can't start."
        : count(piece, "level").checked === 0
          ? "No reasoning levels allowed, so custom members can't use models that have them."
          : "";
    if (warning) {
      warning.hidden = text === "";
      const line = one(warning, "span");
      if (line) line.textContent = text;
    }
  };

  one(piece, "[data-auto]")?.addEventListener("click", () => {
    if (atProject()) auto.project = !autoNow();
    else auto.env = !auto.env;
    paint();
  });
  for (const reset of select(piece, "[data-reset]")) {
    reset.addEventListener("click", () => {
      const state = reset.dataset.reset === "auto" ? auto : lists;
      if (atProject()) state.project = null;
      else if (state === auto) auto.env = false;
      else lists.env = null;
      // The button hides once there is nothing to reset; the row's control is the next stop.
      one(reset.closest(".settings-a__row") ?? piece, "[data-auto], [data-models-toggle]")?.focus();
      paint();
    });
  }
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const next = new Set(listNow() ?? everything());
      if (!next.delete(key(chip))) next.add(key(chip));
      save(next);
      paint();
    });
  }
  for (const provider of providers) {
    const own = select(provider, "[data-chip]").map(key);
    one(provider, "[data-provider-all]")?.addEventListener("click", () => {
      const next = new Set(listNow() ?? everything());
      const full = own.every((entry) => next.has(entry));
      for (const entry of own) {
        if (full) next.delete(entry);
        else next.add(entry);
      }
      save(next);
      paint();
    });
    // One provider's list is open at a time, as in the app.
    const toggle = one(provider, "[data-provider-toggle]");
    toggle?.addEventListener("click", () => {
      const open = toggle.getAttribute("aria-expanded") !== "true";
      for (const other of providers) {
        const shown = other === provider && open;
        one(other, "[data-provider-toggle]")?.setAttribute("aria-expanded", String(shown));
        const body = one(other, "[data-provider-body]");
        if (body) body.hidden = !shown;
      }
    });
  }
  const toggle = one(piece, "[data-models-toggle]");
  toggle?.addEventListener("click", () => {
    const panel = one(piece, "[data-models-panel]");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  piece.addEventListener("pick", (event) => {
    piece.dataset.scope = (event as CustomEvent<string>).detail;
    paint();
  });
  paint();
};

const wireAnswer: Wire = (piece, signal) => {
  const ask = one(piece, "[data-answer-ask]");
  const reply = one<HTMLTextAreaElement>(piece, "[data-answer-reply]");
  const send = one<HTMLButtonElement>(piece, "[data-answer-send]");
  const attach = one<HTMLButtonElement>(piece, "[data-answer-attach]");
  const files = select(piece, "[data-answer-file]");
  if (!ask || !reply || !send || !attach) return;

  // Answer needs something typed, and the page has only three files to attach.
  const follow = () => {
    send.disabled = reply.value.length === 0;
    attach.disabled = files.every((file) => !file.hidden);
  };
  reply.addEventListener("input", follow);
  attach.addEventListener("click", () => {
    const next = files.find((file) => file.hidden);
    if (next) next.hidden = false;
    follow();
    reply.focus();
  });
  for (const file of files) {
    one(file, "[data-answer-remove]")?.addEventListener("click", () => {
      file.hidden = true;
      follow();
      attach.focus();
    });
  }
  send.addEventListener("click", () => {
    send.textContent = "Delivering…";
    send.disabled = true;
    attach.hidden = true;
    for (const remove of select<HTMLButtonElement>(piece, "[data-answer-remove]"))
      remove.disabled = true;
    later(signal, 700, () => {
      ask.hidden = true;
      const count = one(piece, "[data-answer-count]");
      if (count) count.textContent = "0 questions open";
      const empty = one(piece, "[data-answer-empty]");
      if (empty) empty.hidden = false;
      const shelf = one(piece, "[data-answer-shelf]");
      if (!shelf) return;
      shelf.hidden = false;
      one(shelf, "summary")?.focus({ preventScroll: true });
    });
  });
  follow();
};

const ACCESS: Record<string, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};
const SEAT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SEAT_FIELDS = ["seat", "instructions", "provider", "model", "level", "access", "workspace"];

const wireProposal: Wire = (piece, signal) => {
  const card = one(piece, "[data-crew-card]");
  const list = one(piece, "[data-crew-members]");
  const add = one<HTMLButtonElement>(piece, "[data-crew-add]");
  const decline = one<HTMLButtonElement>(piece, "[data-crew-decline]");
  const approve = one<HTMLButtonElement>(piece, "[data-crew-approve]");
  const veil = one(piece, "[data-crew-dialog]");
  const thread = one(piece, "[data-crew-thread]");
  const dock = one(piece, "[data-crew-dock]");
  const blank = one<HTMLTemplateElement>(piece, "template[data-crew-row]");
  const marks = one<HTMLTemplateElement>(piece, "template[data-crew-marks]");
  if (!card || !list || !add || !decline || !approve || !veil || !thread || !dock) return;

  const rows = () => select(list, "[data-crew-member]");
  const values = (row: HTMLElement) =>
    SEAT_FIELDS.map((field) => row.dataset[field] ?? "").join("\n");
  // What the Captain proposed, to tell an edited member from an untouched one.
  const proposed = new Map(rows().map((row) => [row, values(row)]));
  let busy = false;

  const paint = () => {
    const all = rows();
    const seats = all.map((row) => row.dataset.seat ?? "");
    let sound = true;
    for (const row of all) {
      const {
        seat = "",
        provider = "",
        model,
        level,
        access = "",
        workspace,
        instructions = "",
      } = row.dataset;
      const set = (part: string, text: string | null) => {
        const target = one(row, `[data-crew-${part}]`);
        if (!target) return;
        target.hidden = text === null;
        if (text !== null) target.textContent = text;
      };
      set("name", seat === "" ? "New member" : seat.charAt(0).toUpperCase() + seat.slice(1));
      set("runtime", [model, level, ACCESS[access]].join(" · "));
      const mark = marks?.content.querySelector(`[data-for="${provider}"]`);
      if (mark) one(row, "[data-crew-mark]")?.replaceChildren(...mark.cloneNode(true).childNodes);
      if (proposed.has(row)) set("tag", values(row) === proposed.get(row) ? null : "Edited");
      set(
        "workspace",
        workspace === "new"
          ? "New worktree from main"
          : workspace === "existing"
            ? "Existing worktree on tide-chart"
            : null,
      );
      const asks = one(row, "[data-crew-asks]");
      if (asks) asks.hidden = access === "full-access";
      const error = !SEAT_NAME.test(seat)
        ? "Seat names are lowercase words joined by hyphens."
        : seats.indexOf(seat) !== seats.lastIndexOf(seat)
          ? `Seat ${seat} already exists.`
          : instructions.trim() === ""
            ? "Give the custom crew member its instructions."
            : null;
      set("error", error);
      if (error !== null) sound = false;
      const edit = one<HTMLButtonElement>(row, "[data-crew-edit]");
      const remove = one<HTMLButtonElement>(row, "[data-crew-remove]");
      edit?.setAttribute("aria-label", `Edit seat ${seat}`);
      remove?.setAttribute("aria-label", `Remove seat ${seat}`);
      if (edit) edit.disabled = busy;
      // A Crew keeps at least one member.
      if (remove) remove.disabled = busy || all.length === 1;
    }
    const count = one(piece, "[data-crew-count]");
    if (count) count.textContent = `${all.length} ${all.length === 1 ? "member" : "members"}`;
    add.disabled = busy;
    decline.disabled = busy;
    approve.disabled = busy || !sound;
  };

  const fold = one(piece, "[data-crew-fold]");
  fold?.addEventListener("click", () => {
    const content = one(piece, "[data-crew-content]");
    if (!content) return;
    content.hidden = !content.hidden;
    fold.setAttribute("aria-expanded", String(!content.hidden));
    fold.setAttribute(
      "aria-label",
      content.hidden ? "Expand Crew proposal" : "Collapse Crew proposal",
    );
  });
  const more = one(piece, "[data-crew-more]");
  more?.addEventListener("click", () => {
    const full = one(piece, "[data-crew-brief]")?.toggleAttribute("data-full") ?? false;
    more.textContent = full ? "View less" : "View more";
    more.setAttribute("aria-expanded", String(full));
  });

  let editing: HTMLElement | null = null;
  let opener: HTMLElement | null = null;
  const field = (name: string) =>
    one<HTMLInputElement | HTMLTextAreaElement>(veil, `[data-crew-field="${name}"]`);
  const pick = (name: string) => one(veil, `[data-pick="${name}"]`);
  const showOnly = (attribute: string, value: string) => {
    for (const entry of select(veil, `[data-crew-${attribute}]`))
      entry.hidden = entry.getAttribute(`data-crew-${attribute}`) !== value;
  };
  const openDialog = (row: HTMLElement | null, from: HTMLElement) => {
    editing = row;
    opener = from;
    const {
      seat = "",
      instructions = "",
      provider = "claude",
      model = "Haiku 5.5",
      level = "Provider default",
      access = "full-access",
      workspace = "captain",
    } = row?.dataset ?? {};
    const say = (part: string, text: string) => {
      const target = one(veil, `[data-crew-${part}]`);
      if (target) target.textContent = text;
    };
    say("dialog-title", row ? "Edit member" : "Add member");
    say(
      "dialog-about",
      row
        ? "Update this member in the proposed Crew."
        : "Define a new member for the proposed Crew.",
    );
    say("save", row ? "Save changes" : "Add member");
    const name = field("seat");
    const text = field("instructions");
    if (name) name.value = seat;
    if (text) text.value = instructions;
    setPick(pick("provider"), provider);
    setPick(pick(`model-${provider}`), model);
    setPick(pick(`level-${provider}`), level);
    setPick(pick("access"), access);
    setPick(pick("workspace"), workspace);
    showOnly("for", provider);
    showOnly("place", workspace);
    veil.hidden = false;
    thread.inert = true;
    dock.inert = true;
    name?.focus();
  };
  const closeDialog = () => {
    veil.hidden = true;
    thread.inert = false;
    dock.inert = false;
    (opener?.isConnected ? opener : add).focus();
    editing = null;
    opener = null;
  };

  veil.addEventListener("pick", (event) => {
    // The dialog's choices are its own; the card hears of them only on Save.
    event.stopPropagation();
    const name = (event.target as HTMLElement).dataset.pick;
    const value = (event as CustomEvent<string>).detail;
    if (name === "provider") showOnly("for", value);
    if (name === "workspace") showOnly("place", value);
  });
  veil.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return closeDialog();
    if (event.key !== "Tab") return;
    // The dialog is modal, so Tab goes round it and never to the thread behind.
    const stops = select(veil, "button, input, textarea").filter(
      (stop) => stop.offsetParent !== null,
    );
    const at = stops.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
  });
  for (const cancel of select(veil, "[data-crew-cancel]"))
    cancel.addEventListener("click", closeDialog);
  one(veil, "[data-crew-save]")?.addEventListener("click", () => {
    const provider = pickValue(pick("provider"));
    const row =
      editing ?? (blank?.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined);
    if (!row) return;
    if (!editing) list.append(row);
    Object.assign(row.dataset, {
      seat: field("seat")?.value.trim() ?? "",
      instructions: field("instructions")?.value ?? "",
      provider,
      model: pickValue(pick(`model-${provider}`)),
      level: pickValue(pick(`level-${provider}`)),
      access: pickValue(pick("access")),
      workspace: pickValue(pick("workspace")),
    });
    closeDialog();
    paint();
  });

  add.addEventListener("click", () => openDialog(null, add));
  list.addEventListener("click", (event) => {
    const target = event.target as Element;
    const row = target.closest<HTMLElement>("[data-crew-member]");
    if (!row) return;
    const edit = target.closest<HTMLElement>("[data-crew-edit]");
    if (edit) return openDialog(row, edit);
    if (!target.closest("[data-crew-remove]")) return;
    row.remove();
    paint();
    add.focus();
  });

  const decide = (decision: "approve" | "decline", ms: number) => {
    busy = true;
    if (decision === "approve") approve.textContent = "Working…";
    paint();
    later(signal, ms, () => {
      card.hidden = true;
      const notice = one(piece, `[data-crew-notice="${decision}"]`);
      if (!notice) return;
      const count = rows().length;
      const text = one(notice, "[data-crew-notice-text]");
      if (text) text.textContent = `Crew approved · ${count} ${count === 1 ? "member" : "members"}`;
      notice.hidden = false;
    });
  };
  approve.addEventListener("click", () => decide("approve", 800));
  decline.addEventListener("click", () => decide("decline", 350));
  paint();
};

const WIRES: Record<string, Wire> = {
  links: wireLinks,
  proposal: wireProposal,
  "crew-settings": wireCrewSettings,
  answer: wireAnswer,
};

function mount(root: HTMLElement, piece: HTMLElement) {
  const name = piece.dataset.piece ?? "";
  // "Start over" swaps this copy in, taken before anything is touched.
  const fresh = piece.cloneNode(true) as HTMLElement;
  const live = new AbortController();
  wirePicks(piece, live.signal);
  WIRES[name]?.(piece, live.signal);
  piece.addEventListener("click", (event) => {
    (event.target as Element).closest("[data-hot]")?.removeAttribute("data-hot");
  });
  one(root, `[data-piece-reset="${name}"]`)?.addEventListener(
    "click",
    () => {
      live.abort();
      // The copy was taken before the piece first played, so it has to be told it has.
      fresh.setAttribute("data-play", "");
      piece.replaceWith(fresh);
      mount(root, fresh);
    },
    { once: true },
  );
}

export function startPieces(root: HTMLElement) {
  for (const piece of select(root, "[data-piece]")) mount(root, piece);
}
