## 1. Team

**Weights of Sin** built Contexo for the TrueFoundry Forge-a-thon. Team ID TM-AFBECD9C838. Atharva Deo (leader, @atharvavdeo), Bhavik Sheth (@Bhavik-Sheth), Parvati R Iyer and Akshat Bhalani are the four registered members. The team also supplied @ByteMeHarder-404. Its owner, the fourth handle and the members’ affiliations await confirmation.

## 2. Starting point

We started with Microsoft’s VS Code extension samples, specifically webview-view-sample at commit 65c1c44800eeac6fb065a54823ee5ae62c79540a. The sample supplied the webview provider pattern, nonce and content security policy. We added the agent client, editor tools, context index, staging and review engine, terminal client and run journal. The upstream MIT licence ships with the extension. [Upstream record](../UPSTREAMS.md).

## 3. Architecture on TrueForge

A selected function and an inline instruction, or a request in the assistant panel, enters the same run manager. It opens a TrueForge session, sends the turn and streams model text, tool events and approval requests into VS Code. TrueForge owns model inference, turn state and tool dispatch. The CLI uses the same agent protocol.

The editor exposes six MCP tools over authenticated loopback HTTP. Search, read, symbol lookup and context assembly let the agent discover the repository. The other two tools propose writes and run commands. TrueForge pauses for approval before either action. Four core tool schemas are preloaded. Deferred discovery let the Task B agent find the command tool only when it needed pytest.

A write proposal includes the expected file hash and original text. Contexo checks the base, splits the edit into hunks and opens the before/proposed review. The reviewer chooses hunks and applies them. The journal connects that decision to the tool call and session. An interrupted proposal can be reopened, and selected hunks can be tested in a temporary copy before application. [Agent definitions](../extension/trueforge/) · [Editor runs](verification/2026-11-20/local-editor/sessions.json).

## 4. How context is selected

Task B names a feature and masking rules but no paths. Contexo starts with terms from the instruction, BM25 rankings over Python symbols and documentation, symbol-name matches and text hits mapped back to their enclosing symbol. It expands top candidates one dependency hop to find callers, registration sites, tests and documentation.

Reciprocal rank fusion combines the lists with k = 60. The packer places explicit selections and mentions first, reserves space for a test and a documentation candidate, then considers relevance per estimated token. It trims oversized candidates and records reasons for inclusion and omission. The default envelope is 8,000 estimated excerpt tokens. Instructions, tool results and repeated model calls can make the complete turn substantially larger.

On Flask 3.1.3, the editor agent called assemble_context, searched and read files, then proposed changes to src/flask/cli.py, tests/test_cli.py and docs/cli.rst. The applied patch added 73 lines across the three files. An independent run against that exact checkout passed all 60 CLI tests. [Editor patch](verification/2026-11-20/local-editor/B-mercury.patch) · [pytest output](verification/2026-11-20/local-editor/B-mercury-pytest.txt).

## 5. Model setup

Inception Mercury 3 is the default. Contexo starts or connects to local TrueForge. On a fresh installation, select Inception in Setup and save a provider key once. TrueForge stores it and calls the provider. Settings lets users switch the primary and fallback agents. The tested Desktop profile reuses its existing Inception registration.

| Editor session | Input tokens | Cached input | Output tokens | Est. USD |
| --- | --- | --- | --- | --- |
| A · Mercury 3 | 10,400 | 4,179 | 1,101 | $0.00105 |
| B · Mercury 3 | 324,845 | 294,811 | 8,999 | $0.00910 |
| C · unreachable | 0 | 0 | 0 | $0 |

Estimates apply the advertised launch rates of $0.10 per million uncached input tokens, $0.01 per million cached input and $0.35 per million output. Together A and B cost about one US cent at those rates. Account credits, other rehearsals and electricity are excluded. [Provider rates](https://www.inceptionlabs.ai/blog/introducing-mercury-3) · [TrueForge counters](verification/2026-11-20/local-editor/sessions.json).

Local Qwen3 1.7B through Ollama applied a small CLI edit but made no changes on the recorded fixed editor tasks. PrismML Bonsai 4B generated prose locally on Apple silicon. Through the MLX server it emitted tool-call text without dispatching a write. Both local models incurred $0 in hosted inference charges.

## 6. Scorecard

Times refer to the linked evidence reel. Rows identify criteria that still need a competition recording. [Watch the evidence reel](verification/2026-11-20/local-editor/evidence-reel.mp4).

| Judging criterion | Reel | Evidence and claim |
| --- | --- | --- |
| A1 · Inline edit | 00:00–00:12 | Mercury proposed a hunk in VS Code. The accepted edit prints False for FLASK_DEBUG=off. |
| A2 · Agent mode | 00:12–00:21 | Three files changed from a prompt with no filenames. All 60 CLI tests pass and four sensitive key patterns are masked. |
| A3 · Streaming / Stop | Unfilmed | Events stream into the editor. User-initiated cancellation during generation still needs footage. |
| B1 · Context assembly | Run record | The Task B journal records context assembly, searches and reads before the write. The selection rationale needs an on-screen walkthrough. |
| B2 · Diff safety | 00:00–00:07 | The hunk review is visible. A separate extension-host fixture exercised apply and undo. Undo needs footage. |
| B3 · Resilience | 00:27–00:34 | A bad endpoint produced a clear error. The editor kept processing events and Git reported zero changes. |
| B4 · Harness integration | 00:21–00:27 | The live session query identifies the turn and tool events. The journal includes tool discovery and write approval. |
| C1 · Video | 00:00–00:34 | The reel shows evidence for A, B and C in order. A continuous prompt-to-result Task B recording remains open. |
| C2 · Write-up | This PDF | Eight sections document provenance, decisions, model usage, evidence and limitations. |

## 7. Tools used

Claude Code (Opus and Sonnet) and OpenAI Codex assisted development. The product uses the TrueForge TypeScript SDK, MCP SDK, React, Tree-sitter, ripgrep, js-tiktoken and jsdiff. Verification used VS Code 1.147, Vitest, pytest and FFmpeg. [Dependency provenance](../UPSTREAMS.md).

## 8. Known limitations

The Task B editor harness stopped during command approval after the three-file edit had been applied. The independent pytest and masking checks used that checkout. The extension suite passed 210 tests with one TODO. Host commands use the user’s OS permissions. A temporary test copy protects the working tree but does not isolate the process.

With another month we would test interrupted approvals across reloads, add concurrent editor-run isolation and remote-workspace coverage, and validate Code Mode, Skills and native CI adapters against provisioned services. [Detailed readiness assessment](verification/2026-11-20/ASSESSMENT.md).
