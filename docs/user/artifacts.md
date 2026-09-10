# Artifacts

Artifacts are planning documents generated while an agent works, such as plans, specifications,
research notes, and diagrams. J5 Code stores these files under the project workspace's shared
`artifacts/` directory and shows them in the Artifacts page.

Use Artifacts for durable, user-consumable planning outputs that should remain available across
threads and agents. Do not use it for source code, build output, logs, temporary scratch files, or
ordinary repository documentation.

Open Artifacts from the folder icon at the bottom of the sidebar. Choose a project workspace, then
choose a file to preview it. Markdown, text, source files, common image formats, and sandboxed HTML
documents can be previewed without opening an editor. HTML previews cannot run scripts or access
J5 Code's page context.

From a project thread, you can also open the right panel and choose **Artifacts**. This view stays
scoped to the current project workspace, so planning documents remain beside the conversation while
you work. Artifact file references in chat use a distinct **Artifact** chip; choose one to open that
document directly in the Artifacts panel.

While the Artifacts page is open, its file list and the selected preview update automatically when
an agent creates, edits, or removes a file in the project's `artifacts/` directory.

When a provider emits a structured proposed plan, J5 Code saves the completed plan automatically as
the shared `artifacts/plan.md`. Agents are also instructed to put other planning documents in that
same directory. Artifacts are shared by every agent working in the project rather than partitioned
by thread.

In a Git workspace, J5 Code adds `/artifacts/` to Git's local exclude file at `.git/info/exclude`.
This keeps generated documents out of commits without modifying the repository's tracked
`.gitignore`. If the repository already tracks files under `artifacts/`, J5 Code refuses to hide the
directory and shows an error in the Artifacts page.

Artifacts are local to the environment and project workspace where they were generated. They are
not synced between machines or treated as shared Squadron documents.
