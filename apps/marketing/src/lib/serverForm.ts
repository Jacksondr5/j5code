import { serverPromptLinkUrl } from "./promptLink";

/** Wires a link page's "Open on my server" form to open `appPath` on the address entered. */
export function wireServerForm(appPath: string) {
  const form = document.getElementById("server-form") as HTMLFormElement;
  const address = document.getElementById("server-address") as HTMLInputElement;
  const addressError = document.getElementById("server-error") as HTMLElement;
  address.addEventListener("input", () => {
    addressError.hidden = true;
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = serverPromptLinkUrl(address.value, appPath);
    if (target === null) {
      addressError.hidden = false;
      address.focus();
      return;
    }
    window.location.assign(target);
  });
}
