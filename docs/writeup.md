## 1. Team

**Weights of Sin** · Team TM-AFBECD9C838. Atharva Deo (lead, @atharvavdeo, D. J. Sanghvi College of Engineering), Bhavik Sheth (@Bhavik-Sheth), Parvati R Iyer and Akshat Bhalani (@ByteMeHarder-404).

## 2. Starting point

A developer wants an agent to make two different kinds of changes. First, they select a Flask helper and ask for a precise behavior change inside the function. The selection gives the agent a starting point and gives the reviewer a boundary to check. Then they ask for a CLI command that displays configuration and masks sensitive values. The agent has to find where commands are registered, how they are tested, and where users learn to use them.

Both tasks end in the source editor. The developer inspects the proposed hunks, chooses what to apply, and verifies what landed. We built this workflow on Microsoft’s MIT-licensed VS Code webview sample. It supplied the sidebar, content security policy and asset loading. Contexo adds a TrueForge-backed agent, repository context and native review. [Upstream record](../UPSTREAMS.md)

## 3. Architecture on TrueForge

![Contexo architecture. VS Code and the CLI start scoped TrueForge sessions. TrueForge calls the configured model and dispatches tools over authenticated loopback MCP. Contexo owns repository context, hunk review, the working tree, candidate checks and evidence.](contexo-architecture.svg)

TrueForge owns inference, conversation state and tool approvals. Contexo supplies workspace-scoped reads and proposals over authenticated MCP. The editor verifies the file revision before staging a diff and again before saving accepted hunks. Command execution has its own approval. An eligible primary-model failure can start a fresh fallback session before approval. The journal records the context delivered, review decisions and checks. [Architecture and runtime details](../README.md#architecture)

## 4. How context is selected

**First turn.** An inline edit starts with the selected code, its path and line range, and the full-buffer hash. A repository-wide turn starts with the goal. Contexo indexes Python symbols, imports and calls with Tree-sitter, then maps documentation by heading. For Go and Rust, live search supplies source previews and coordinates for exact reads.

**What enters the model.** Explicit selections, paths and symbol anchors take priority. Plain keywords inform ranking. Contexo fuses BM25, symbol matching, live search and local sparse TF-IDF vectors. One-hop expansion links a leading implementation to registration sites, callers, tests and docs. The packer protects these roles, removes overlapping excerpts, and trims long symbols around signatures or matching lines. It budgets 8,000 estimated source tokens by default and separately caps the escaped response at 22,000 characters. The delivered packet records ranges, reasons and omissions.

**What a file contributes.** The file map explains why a file matters and what it contains. It shows the current buffer or checkout against Git HEAD, the latest file-changing commit subject and short before-and-after samples. The agent can request exact historical lines or read the current range. A range proposal then sends the path, coordinates, hash and replacement. Contexo reconstructs the diff against the live file.

**What carries across steps.** TrueForge compacts the conversation and loads deferred tools on demand. Contexo’s journal preserves the goal, delivered source pointers, review decisions and observed checks. A checkpoint pages decisions in groups of 12. The agent can reopen the affected source at its current revision. Ranking data is reused per index snapshot. Git history is cached by immutable revision.

**From intent to evidence.** In the HTTPX run, the goal was to reject invalid command-line timeouts and preserve Python API behavior. The packet brought together the flag declaration, CLI tests and timeout guide. Mercury received 19 excerpts in 21,777 serialized characters, read all three target files, and scoped six replacements to source it had read. After review and feedback, it reopened the test and guide on their new revisions and issued the verification command.

**Budget across the run.** The packet budget governs repository evidence. The model also receives instructions, tool schemas, prior turns and tool results. Leaving room for output matters because a line-range proposal needs to return the replacement plus the source coordinates. Keeping earlier decisions in the checkpoint lets the agent recover them without copying prior diffs back into the next packet.

![LMCache in-memory context assembly. Median latency was 3,736 ms for a rebuilt ranking snapshot and 118 ms for warm reuse.](architecture/context-cache-results.svg)

On pinned LMCache and HTTPX, filename-free probes delivered **5/5** and **3/3** required files, respectively. The chart compares 12 cold and 12 warm runs over 24,952 LMCache symbols. Excerpt order matched. Timing covers in-memory assembly. [Delivery and cache evidence](verification/2026-11-21/AGENT_BRIDGE.md#retrieval-and-range-edit-follow-up)

## 5. Model setup

Mercury 3 is the hosted default. Switch the primary and fallback in Contexo Settings. TrueForge holds the provider credentials. The Flask editor A/B sessions cost an estimated **$0.0102 combined** at Inception’s launch rates. The two Mercury HTTPX turns cost about **$0.0102** on the same basis. Qwen3 1.7B ran locally through Ollama, and Bonsai 4B ran locally through MLX. Local runs had no hosted API charge. [Pricing basis](https://www.inceptionlabs.ai/blog/introducing-mercury-3) · [Session counters](verification/2026-11-20/local-editor/sessions.json)

## 6. Scorecard

| Criterion | Reel or record | Evidence |
| --- | --- | --- |
| A1 · Inline edit | 00:07–00:12, A record | Reviewed inline patch. FLASK_DEBUG=off prints False. |
| A2 · Agent mode | 00:12–00:21, B record | Three files discovered. All 60 CLI tests passed. |
| A3 · Streaming / Stop | Editor and CLI logs | Streamed events and cancelled command approval. |
| B1 · Context selection | B record | Source, tests, guide and selection reasons recorded. |
| B2 · Diff safety | Packaged host test | Mixed review, undo, redo and stale-base checks passed. |
| B3 · Resilience | 00:27–00:34, C record | Clear endpoint error and clean Git. Fallback fixture passed. |
| B4 · TrueForge | 00:21–00:27, B record | MCP tools, deferred discovery and write approval recorded. |
| C1 · Video | 00:00–00:34 | Evidence reel follows A, B and C in order. |
| C2 · Write-up | This PDF | Three pages with the eight required headings. |

[Flask verification and evidence reel](verification/2026-11-22/SUBMISSION.md)

![Independent HTTPX behavior checks passed. Mercury 3 scored 15 of 15 after repair. Native Bonsai and the clean baseline each scored 6 of 15.](architecture/httpx-model-results.svg)

Mercury’s repaired HTTPX patch passed **13 CLI tests** and **1,418 upstream tests** under the matched comparison protocol. The independent oracle checked invalid values, the default, valid fractions and Python API behavior. [Benchmark method and patches](verification/2026-11-21/model-comparison/README.md)

## 7. Tools used

Claude Code and OpenAI Codex assisted development. The implementation uses the TrueForge and MCP TypeScript SDKs, React, Tree-sitter, ripgrep, js-tiktoken, jsdiff and SQLite. Verification used VS Code, Vitest and pytest. FFmpeg produced the reel. [Dependency provenance](../UPSTREAMS.md)

## 8. Known limitations

Mercury’s first HTTPX patch needed feedback to repair the test file and Markdown fence. Native Bonsai emitted a tool request as text and made no source changes. An experimental adapter delivered all three relevant files after the retrieval fix, but the model exhausted its 512-token output allowance before a read or write. The upstream suite excluded one pre-existing Trio failure on both revisions.

The evidence reel uses excerpts. The full submission requires continuous prompt-to-diff footage and public links. With another month, we would validate an actual 100-file migration through forced compaction, run interrupted-apply and remote-host tests, and rehearse on a second model. Local two-root routing is covered by the packaged fixture. [Remaining implementation and verification](REMAINING_WORK_PLAN.md)
