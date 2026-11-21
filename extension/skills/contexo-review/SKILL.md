---
name: contexo-review
description: Use the Contexo MCP harness to gather workspace context and stage reviewable edits inside VS Code. Use when the user asks for Contexo, an inline Contexo edit, or an edit gated by hunk review.
---

Use the connected `contexo` MCP tools for this workflow. If they are unavailable, direct the user to the Contexo connection setup.

1. Call `editor_selection` for a request about selected code. Call `assemble_context` with the user goal and file or symbol mentions. Set `useEditorSelection` only when the selection belongs to the request.
2. Use the file map, packet ranges and inclusion reasons to choose what needs an exact `read_file` call. Use `file_context` when the edit depends on previous behavior, a dirty buffer, or a recorded design decision. Request a specific historical line range with `version: "head"` or `version: "previous"`. The packet can contain trimmed excerpts. Read the smallest exact range that covers the change. When the result is `rangeWritable`, pass `startLine`, `endLine`, and the full-file hash to `propose_write` along with the replacement text.
3. Send related edits together to `propose_write`. The editor opens the source file for hunk review. Ask the user to apply or reject the proposal in VS Code and keep its review ID.
4. Use `review_status` after the user acts. Describe a change as applied only when the result confirms it. If a base changed, reread it and rebuild the proposal.

For a request routed through Contexo, keep the workspace edits within its approval flow.
