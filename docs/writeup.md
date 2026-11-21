## 1. Team

**Weights of Sin** · Team TM-AFBECD9C838. Atharva Deo (lead, @atharvavdeo), Bhavik Sheth (@Bhavik-Sheth), Parvati R Iyer and Akshat Bhalani (@ByteMeHarder-404).

## 2. Starting point

A selected Flask helper asks for precision. A request for a new CLI command starts with intent alone and spans registration, implementation, tests and documentation. Both end in the same editor review. The developer can inspect each hunk, trace its source and decide what to apply.

We started with Microsoft’s MIT-licensed VS Code webview sample at commit 65c1c44800eeac6fb065a54823ee5ae62c79540a. It provided the sidebar, content security policy and asset loading. We extended it with TrueForge sessions, repository context and a hunk review workflow. [Upstream record](../UPSTREAMS.md)

## 3. Architecture on TrueForge

![Contexo architecture. VS Code and the CLI start scoped sessions with TrueForge. TrueForge calls the configured model and routes approvals and tools over authenticated loopback MCP. Contexo owns the repository index, hunk review, working tree, candidate checks and evidence.](contexo-architecture.svg)

TrueForge owns inference, tool dispatch and streamed approvals. Authenticated loopback MCP connects it to the editor, which stages edits so the reviewer controls what reaches disk. Search, exact reads, context assembly, checkpoints, proposals and allowlisted commands are exposed over MCP. Commands get a separate approval. An eligible model failure can start one fallback session before approval. Stop cancels the turn and discards pending review. [Agent definitions](../extension/trueforge/) · [Recorded sessions](verification/2026-11-20/local-editor/sessions.json)

## 4. How context is selected

For the Flask CLI task, the user names the behavior and no paths. Contexo finds the command implementation, tests and docs, then sends bounded source and reasons. The model requests exact current text before proposing a patch. Inline requests start with the selected range and its file hash.

| Context step | What it gives the model |
| --- | --- |
| **Anchor and retrieve.** Prioritize the selection and mentions. Combine names, BM25, ripgrep and TF-IDF. | The user’s target plus exact and related matches. Python uses parsed symbols. Rust and Go can contribute labelled source previews. |
| **Expand and pack.** Follow one hop to calls, callers, registration, tests and docs. Fuse ranks and reserve space for tests and docs. | Complementary evidence under 8,000 estimated excerpt tokens by default and a 22,000-character serialized cap. |
| **Explain each file.** Include up to eight file summaries and prepare before-and-after samples for up to three. | Why a file matters, its contents, working changes, Git history and optional historical reads. |
| **Continue across turns.** TrueForge compacts the conversation. Contexo’s checkpoint restores goal, source pointers, paged decisions and check statuses. | Stable evidence for the next small edit batch. Exact rereads and hash checks bind each edit to current source. |
| **Trace the result.** Record delivered ranges, reasons and packet digest beside tools, approvals and checks. | A reviewer can follow the evidence from model input to reviewed diff and checks. |

[Anthropic context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents) · [Cursor dynamic context discovery](https://cursor.com/blog/dynamic-context-discovery)

## 5. Model setup

In Setup, choose Inception and save a provider key in TrueForge for Mercury 3, the default. Settings lets developers switch the primary and fallback agents.

| Editor session | Input tokens | Cached input | Output tokens | Est. USD |
| --- | --- | --- | --- | --- |
| Inline edit · Mercury 3 | 10,400 | 4,179 | 1,101 | $0.00105 |
| Multi-file edit · Mercury 3 | 324,845 | 294,811 | 8,999 | $0.00910 |
| C · Resilience check | 0 | 0 | 0 | $0 |

The two Mercury 3 sessions total about one US cent at Inception’s launch rates of $0.10 for uncached input, $0.01 for cached input and $0.35 for output per million tokens. The estimates cover hosted inference for these runs. [Provider rates](https://www.inceptionlabs.ai/blog/introducing-mercury-3) · [Session counters](verification/2026-11-20/local-editor/sessions.json)

Compatibility checks also used Qwen3 1.7B via TrueForge and Bonsai 4B on Apple MLX. The bounded Bonsai experiment produced an exact four-file patch among 1,004 fixture files and exact single-line edits on upstream Flask and ripgrep. [Compatibility evidence](verification/2026-11-21/AGENT_BRIDGE.md)

## 6. Scorecard

The evidence reel follows the three competition tasks in order. It shows an inline edit, an agent-led change across three files and an endpoint resilience check with a clean checkout. The table pairs the footage with the run logs and editor checks. [Evidence reel](verification/2026-11-20/local-editor/evidence-reel.mp4)

| Judging criterion | Reel | Evidence |
| --- | --- | --- |
| A1 · Inline edit | 00:00–00:12 | The reviewer accepts the proposed hunk in VS Code. The check prints `False` for `FLASK_DEBUG=off`. |
| A2 · Agent mode | 00:12–00:21 | A single prompt produces a 73-line patch across three files. Independent checks pass 60 CLI tests and verify four masked values and one visible public value. |
| A3 · Streaming / Stop | Run log | The editor streams session events. A CLI run confirmed cancellation during command approval. |
| B1 · Context assembly | Run log | Source ranges and selection reasons precede the proposal. The journal links their receipt to the turn. |
| B2 · Diff safety | 00:00–00:07 | The reel shows hunk review. An extension-host fixture exercised apply and undo. |
| B3 · Resilience | 00:27–00:34 | The editor stays responsive and preserves a clean Flask checkout during the endpoint resilience check. |
| B4 · Harness integration | 00:21–00:27 | A live TrueForge session query shows the turn and tool events. The journal records tool discovery and write approval. |
| C1 · Video | 00:00–00:34 | The reel covers Tasks A, B and C in order. |
| C2 · Write-up | This document | The write-up covers the starting point, architecture, model usage, verification and limitations. |

## 7. Tools used

Claude Code (Opus and Sonnet) and OpenAI Codex assisted development. Contexo uses the TrueForge TypeScript SDK, MCP SDK, React, Tree-sitter, ripgrep, js-tiktoken and jsdiff. Verification used VS Code 1.147, Vitest and pytest. We assembled the evidence reel with FFmpeg. [Dependency provenance](../UPSTREAMS.md)

## 8. Known limitations

Task B’s editor run stopped at command approval after applying the patch. Independent checks on that checkout produced the passing results. The native Bonsai editor run emitted a tool request as text. The successful per-file run used an experimental driver. Its Go probe rejected two incomplete Bonsai edits. The 120-file test verifies review-state pagination. An actual 100-file model edit and forced provider compaction remain release checks.

With another month, we would add revision-pinned dependency batches and multilingual graph expansion, then test restart, compaction and candidate checks on large repositories. Reviewer evidence comes from source, tools and diffs. Model explanations are summaries and do not establish the model’s internal reasoning. [Verification](verification/2026-11-21/AGENT_BRIDGE.md)
