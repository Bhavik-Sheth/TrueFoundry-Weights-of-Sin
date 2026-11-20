# Contexo readiness · 20 November 2026

The strongest competition evidence is the real three-file Flask change. The main remaining risk is reproducing and recording the full editor workflow in the required order. All Flask results below refer to tag 3.1.3, commit 22d924701a6ae2e4cd01e9a15bbaf3946094af65. The Desktop demo checkout was prepared separately from the rehearsals.

| Judging item | Implementation and observed result | Remaining proof |
| --- | --- | --- |
| Inline edit | Editor selection, right-click command, natural-language prompt, native diff, hunk decisions and undo. A real extension-host fixture applied a hunk and restored the original file. Mercury passed the specified OFF check via CLI inline. | Installed-editor verification now includes an accepted hunk and False. See [evidence reel](local-editor/evidence-reel.mp4). |
| Agent mode | TrueForge drove retrieval, reads and proposed edits to src/flask/cli.py, tests/test_cli.py and docs/cli.rst from the prompt without filenames. The first proposal failed on timedelta serialization. Mercury corrected it after seeing the failure. The corrected checkout passed 60 tests. | Editor applied three files. The harness stopped at command approval. Independent checks passed and the reel queries the recorded session. A continuous competition take remains open. |
| Context selection | Explicit file/symbol anchors, corpus-derived vectors, BM25, symbol/graph expansion, budget and omission display. A live request exceeded TrueForge's tool-response limit during the B rehearsal. The formatter now budgets for the serialized response as well as excerpt tokens. | Show the selected implementation, test and docs in the editor on a fresh B run. Reconfirm the transport limit fix on that run. |
| Review and undo | Native per-hunk review and undo, sidebar changes list, before/proposed workbench, stale-base checks and interrupted-apply checkpoint. A separate local candidate copy ran pytest without modifying its source checkout during the suite. | Exercise mixed decisions and undo with the final Desktop build. Candidate tests execute under the user's OS account. |
| Streaming and cancellation | Streaming and human approvals observed on Mercury and Qwen. Stopping the CLI during command approval cancelled the turn. | Capture an editor cancellation during generation and compare workspace state. |
| Resilience | Run manager classifies failures and can seal the failed session and start the configured fallback. Desktop uses distinct Mercury and Qwen agents. | Unreachable-endpoint editor run produced an error, nine event-loop ticks and clean Git. Successful automatic takeover remains unfilmed. |
| Harness integration | Both model backends used TrueForge. Recorded events show real MCP reads, tool discovery, approvals and applied hunks. The built bundles passed the provider-dependency scan. | Show the session and tool calls on screen for B. |
| Submission | Fork point, licence, setup, task wording, results and runbook are present. | Three-page A4 PDF and timestamped evidence reel available. The team affiliations, remaining handles and continuous competition video require confirmation. |

## Additional feature coverage

| Feature | Available now | Remaining or unverified |
| --- | --- | --- |
| Extension visuals | Sidebar gradient, responsive tabs, tool argument/result cards, context graph, run state, review actions and composer. Shared review workbench displays code cards, commit lanes and replay. | Sidebar rendering and outgoing actions checked with the compiled webview in Edge. Final native user interaction remains manual. |
| CLI and assistant | Standalone ask, inline, doctor, commits, review, replay and optional candidate pytest. The sidebar and VS Code chat participant call the editor run manager. | Native chat participant has not had a separate live user-session acceptance run. |
| Replay | Native, ACP and OTLP imports; previous/next navigation; local run journal with session and tool IDs. | Full source-event deduplication, cursor transactions and producer-version coverage. |
| Recovery | Persisted review decisions, root/session ownership checks, explicit restore and interrupted-apply recovery. | General interrupted streaming turns, ambiguous approval delivery and crash-injection matrix. |
| Evidence | Manually link requirements to hunks and checks; SARIF matching accounts for side, line and matching content hash. | Cross-revision rename tracking and complete stale/conflicting evidence UI. |
| External integrations | Read Jenkins build data, GitHub PR review comments including bot comments, and digest-checked BuildKit statements. Credentials use editor secret storage. | Live account validation, repeated-sync deduplication, provider cursors, OCI ingestion and direct CodeRabbit account integration. |
| Impact | Editor definition/reference commands and Python before/after call/import comparison, with inferred module links where resolvable. | Dynamic dispatch and complete cross-language candidate graph resolution. |
| Advanced TrueForge | Registration accepts configured sandbox and skills. The local runtime advertised sandbox and skill support; its environment and skill lists were empty during inspection. | Actual skill loading and Code Mode execution require a provisioned environment and run evidence. |
| Workspace ownership | Dedicated session-scoped MCP routes. CLI invocations have separate hosts and selected roots. Inline edit rejects selections outside the editor's active root. | Multiple concurrent editor runs in one window, full multi-root ownership, shared-file locks and remote-host acceptance. |
| Tests | Host/webview typecheck, production build, provider scan, local review HTTP smoke and 210 passing tests. One previously declared TODO remains. | Live fixed editor tasks, external integrations, sandbox runtime and final submission recording. |

## Evidence

- [Mercury edit](mercury-edit.jsonl) and [Qwen edit](qwen-edit.jsonl) applied the same reviewed hunk.
- [Flask A replay](flask-A-cli.jsonl), [patch](flask-A.patch) and [observations](observations.json).
- [Flask B replay](flask-B-cli.jsonl), [initial failure](flask-B-before-fix.txt), [corrected patch](flask-B.patch), [passing tests](flask-B-pytest.txt), [help](flask-B-help.txt) and [masked JSON](flask-B-config.json). The post-fix tests and CLI output were captured independently from the agent session.
- [Extension suite](vitest.txt), [compiled sidebar preview](extension-sidebar.png) and [workbench with the Flask diff](review-gradient.png). The sidebar preview replays a recorded read_file event through a browser bridge.
