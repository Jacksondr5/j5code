# Artifacts

Artifacts are planning documents generated while an agent works, such as plans, specifications,
research notes, and diagrams. J5 Code stores these files in its application data, outside the
repository, and shows them in the Artifacts page.

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
an agent creates, edits, or removes a project artifact.

When a provider emits a structured proposed plan, J5 Code saves the completed plan automatically as
the shared `artifacts/plan.md`. Agents use J5 Code's artifact tools to create and read other planning
documents. Artifacts are shared by every agent working in the project rather than partitioned by
thread. The `artifacts/` prefix shown in chat is a logical path and does not create a directory in
the repository, so no Git ignore rule is needed.

Artifacts are local to the environment and project where they were generated. They are
not synced between machines or treated as shared Squadron documents.
