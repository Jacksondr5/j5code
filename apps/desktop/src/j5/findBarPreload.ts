import { ipcRenderer } from "electron";

import {
  FIND_BAR_COMMAND_CHANNEL,
  FIND_BAR_FOCUS_CHANNEL,
  FIND_BAR_MATCHES_CHANNEL,
  type FindBarCommand,
  type FindMatches,
} from "./findBarProtocol.ts";

const send = (command: FindBarCommand) => ipcRenderer.send(FIND_BAR_COMMAND_CHANNEL, command);

window.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("query");
  const count = document.getElementById("count");
  if (!(input instanceof HTMLInputElement) || count === null) return;

  input.addEventListener("input", () => send({ type: "query", text: input.value }));
  document.getElementById("close")?.addEventListener("click", () => send({ type: "close" }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      send({ type: "close" });
    } else if (event.key === "Enter" && event.target === input && !event.isComposing) {
      event.preventDefault();
      send({ type: event.shiftKey ? "previous" : "next" });
    } else if (event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      input.select();
    }
  });
  document.querySelector("form")?.addEventListener("submit", (event) => event.preventDefault());

  ipcRenderer.on(FIND_BAR_FOCUS_CHANNEL, (_event, query: string) => {
    input.value = query;
    input.focus();
    input.select();
  });
  ipcRenderer.on(FIND_BAR_MATCHES_CHANNEL, (_event, matches: FindMatches | null) => {
    count.textContent =
      matches === null
        ? ""
        : matches.total === 0
          ? "No results"
          : `${matches.active} of ${matches.total}`;
  });
});
