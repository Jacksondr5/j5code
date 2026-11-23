/** The Inbox section's copy, which is also the page's headline while the Inbox leads it. */
export const INBOX_HEADING = "Read and answer in the Inbox the way you do in a thread";

export const INBOX_INTRO =
  "Links in an agent's question now open in that agent's own panel, right beside the Inbox, so you can read the pull request, file or diff while you write your answer. And the reply box works like the composer.";

export const INBOX_ITEMS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "Links open beside the Inbox",
    body: "A pull request, file, commit, artifact or web page linked in a question opens in the asking agent's panel, next to your reply. Click a link in another question and the panel switches to that agent.",
  },
  {
    title: "It's the agent's own panel",
    body: "Tabs you open from the Inbox are there when you open the agent's thread, and its + menu offers the thread's tabs.",
  },
  {
    title: "Answer like you chat",
    body: "The reply box is the composer's editor: Enter sends, following your send setting, and your answer arrives exactly as you typed it. If one answer fails to send, the error shows under that question and the others stay usable.",
  },
  {
    title: "Attachments like the composer",
    body: "Screenshots and files show full previews you can open, HEIC photos work, and large images are shrunk to fit.",
  },
  {
    title: "Copy, times and skills",
    body: "Every message has a copy button, hovering “open 3h” shows the exact time, and $skill mentions show as chips.",
  },
];
