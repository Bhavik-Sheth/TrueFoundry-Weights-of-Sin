# Contexo verification · 21 November 2026

Candidate based on release branch `eb68c4f` with the upstream Flask follow-up. VS Code 1.147.0 on macOS arm64. TrueForge runtime 0.185.1, SDK 0.185.0, and Claude Code 2.1.311. Candidate VSIX SHA-256 `7d44135906ec19943656bf0cae7cf87a875a6fec8c926ff6d5cdf1010c3ee328`.

| Check | Outcome |
| --- | --- |
| TypeScript, unit suite, VSIX | TypeScript passed. Vitest recorded 224 passes and one TODO. The host and webview bundle marker check passed before packaging and against the assembled VSIX. The archive contains the upstream license and Copilot skill. |
| Packaged editor and MCP | A disposable workspace rejected a wrong credential, exposed discovery and staging through its workspace connection, and returned the selected source in the delivered context. The real source editor displayed hunk controls. Staging preserved the original file on disk. |
| Mixed apply and stale buffer | A repeated submission with the same request ID opened one review. The test accepted one hunk and rejected one, verified the exact on-disk result, then verified undo and redo against file contents. A later unsaved change prevented a stale apply and stayed in the editor. |
| Claude Code | The CLI reported a connected Contexo MCP server using a disposable project and substituted environment credential. The editor smoke test independently called the same MCP endpoint. |
| TrueForge inline fixture | An isolated TrueForge process encountered a deliberately unreachable primary, created a fallback session and sent the selected code and assembled context to a scripted model. The model proposed a source hunk. The file changed only after Apply, the intent was journaled and the TrueForge turn completed. |
| Versioned context in model input | The packaged editor returned the selected file's Git history over MCP. The isolated TrueForge provider asserted that its actual input contained the file's selection reason, last commit subject, and lines from both sides of that commit before staging the native editor edit. A disposable Git test read the exact previous line across a committed rename and verified the eight-file cap with 29 candidate paths. |
| Hosted inference | On the existing runtime the primary failed as configured and the fallback session opened. The configured Mercury endpoint rejected its model ID. The source fixture stayed unchanged. |
| Copilot | Extension MCP discovery and a native Copilot configuration are provided. A signed-in Copilot model turn was outside the isolated editor run. |

## Current candidate summary

This section records the earlier 22 November candidate. The later [submission audit](../2026-11-22/SUBMISSION.md) adds the adapter, durable batches and two-root fixture. Typecheck and packaging passed. Vitest recorded **228 passes and one TODO**. Pinned Flask, Go and Rust harness checks passed. Rust verification covered retrieval, exact diff and stale-base rejection. The packaged editor fixture exercised checkpoint recovery, an exact range read and review before writing the native source file.

In the [live HTTPX comparison](model-comparison/README.md), Mercury’s first patch passed all 15 independent behavior cases but required feedback to repair test collection and the Markdown fence. The repaired run completed 13 CLI tests through Contexo, and the independent suite passed 1,418 tests with one skip and the same existing Trio test excluded from baseline and candidate. Native Bonsai dispatched zero tools. The adapter retry after the bare-mention fix delivered all three required files before it reached the local output limit. [Current implementation and release gates](../../REMAINING_WORK_PLAN.md#current-implementation-and-release-gates)

## Reproduce

From `extension/`, run `npm run typecheck`, `npm test` and `npm run package`. From the repository root, run the packaged-host test with `node extension/test/host/run.cjs`. Set `VSCODE_CLI` to the VS Code CLI path if it is absent from PATH. Set `CONTEXO_CLAUDE_EXECUTABLE` to also check Claude Code discovery.

For a separate TrueForge instance and deterministic model, run `node extension/test/host/runtimeFixture.mjs`. It creates disposable storage, two synthetic agents and an isolated VS Code profile, and turns on the native inline assertion. `CONTEXO_TRUEFORGE_CLI` can point to an existing 0.185.1 JavaScript CLI instead of launching the pinned npm package.

## Implementation-plan coverage

| Workstream | Implemented or exercised in this change | Remaining acceptance work |
| --- | --- | --- |
| Registration | Shared wizard and CLI reconciliation, unchanged-resource detection, read-back after errors, explicit connector rotation, pinned launcher and runtime inspection. | Full permission, conflict and lost-acknowledgement fault matrix on clean runtime profiles. |
| Event storage | SQLite allocates event sequence numbers and records review projections in the same transaction. Review snapshots use digest-verified artifacts. Legacy JSONL bytes are preserved on migration, and JSONL remains the portable view and runtime fallback. | Durable remote cursor and effect ledger; power-loss, retention and migration fault matrix. |
| Replay | Native and OTLP records deduplicate by source identity. ACP tool updates accumulate under their call IDs. Replay projects proposal, approval and check state. | Cross-archive deduplication, content-addressed exports and a dedicated playback UI. |
| Recovery | Pending external review decisions persist. Apply checks the live base and open buffer version. Interrupted applies retain a checkpoint. TrueForge approval errors reconcile against the server without automatic resubmission. A dropped-stream fixture reconnects by cursor without replaying a tool call or text already shown. | Kill/restart at every apply and approval boundary; live transport fault injection. |
| Evidence | Requirement revisions are retained. SARIF resolution supports artifact indices, base URIs, regions and fingerprints. Hunk matching requires the recorded revision and side. | Full evidence disposition UI, revision comparisons for provider checks and accepted-candidate diagnostics. |
| Providers | Jenkins test-report status, bounded retries, digest reporting for BuildKit file imports and unchanged refresh deduplication. Existing GitHub comment pagination remains supported. | Persistent provider cursors, OCI registry retrieval, review thread resolution and authorized live CI checks. |
| Code intelligence | VS Code implementations and bounded caller/callee results extend definition and reference navigation. Results are discarded when the source document changes. | Root-aware caching, equivalent provider snapshots on both sides of a diff and the language-host matrix. |
| Runtime and ownership | Runtime capability inspection, workspace binding, per-run command cancellation, and serialized mutation through the review engine. | Parallel edit runs, full multi-root and SSH/virtual filesystem operation, and provisioned Skills and Code Mode execution. |
| Competition release | Packaged-host acceptance and synthetic TrueForge fixture passed. | Live fixed-task rehearsal, network destination trace, full artifact/retention matrix, and continuous competition evidence. |

## Context retrieval scale check

The same 30,000-symbol synthetic in-memory corpus and 21 exact-identifier requests ran against the assembler before and after the retrieval cache. The first request warmed the index. The remaining 20 requests had a measured p50 of 430.3 ms before and 47.4 ms after, and a p95 of 477.6 ms before and 49.7 ms after. Payload text matched byte for byte for all 21 cases, and the target source appeared in every payload. The measurement includes context assembly and rendering on Node 22.22.3. File crawling, language servers, ripgrep subprocesses, hosted inference and semantic task quality were outside this measurement.

## Bonsai 4B coordinated-edit probe

Ran `prism-ml/Bonsai-4B-mlx-1bit` locally on Apple Silicon with MLX 0.31.2 and MLX-LM 0.31.3. Stock MLX rejected native 1-bit packing. The probe used the same weight codes, verified bit-for-bit and repacked into the stock GPU kernel's 2-bit storage layout. No model weights were retrained or requantized.

| Path | Observed result |
| --- | --- |
| Packaged VS Code and TrueForge 0.185.1 | On a one-line edit, the Bonsai fallback returned a `read_file` request as assistant text and ended the turn. TrueForge recorded 4,664 input and 19 output tokens. The source stayed unchanged and the editor displayed no proposal. |
| Coordinated edit in a synthetic 1,004-file Git repo | The actual Contexo assembler delivered all four intended files and none of the 1,000 similarly named plugin files. The excerpts used 104 estimated source tokens. The first one-shot request used 822 measured input tokens and returned malformed patch JSON. The harness rejected it before staging. |
| Experimental per-file loop | The first version passed both behavior tests but added two unintended documentation lines. A tighter file-local instruction produced a minimal, exact four-file patch. Existing Contexo CLI staging and apply wrote it in the disposable workspace. Both unit tests and independent checks for the default, explicit override, plugin default, and absence of extra edits passed. Four model calls used 414 input and 140 output tokens, summed before cache discounts. |

The per-file loop was an evaluation driver. It selected files from the actual assembled context, supplied exact current text, and converted the model's file outputs into version-checked proposals. Its synthetic acceptance oracle checked the exact patch before applying it. It did not exercise native tool calling or production orchestration for the four-file change. The repository count tests distraction and retrieval in this fixture. The files to edit were short.

## Long-context and upstream code checks

| Case | Observed result |
| --- | --- |
| 120-file proposal | Ten 12-file pages preserved all decisions without returning patch text. A stale proposal key and a cross-run pending proposal were rejected. |
| Recovery after journal reopen | The checkpoint recovered the fallback run's original goal, earlier source receipt and checks after 150 unrelated events. An oversized excerpt and another run's check stayed outside the result. |
| Packaged continuation | A deterministic TrueForge model requested a checkpoint before proposing its edit. It verified the stored SHA-256 against the exact context it received and checked the turn ID and source pointer. This exercised the checkpoint call itself without forcing provider compaction. |
| [Python · Flask](https://github.com/pallets/flask/tree/22d924701a6ae2e4cd01e9a15bbaf3946094af65) | In 235 tracked files, identifier retrieval found `src/flask/helpers.py`. A version-checked hunk changed handling of `FLASK_DEBUG=off`. Independent checks passed for both off and enabled modes. Bonsai also produced the exact bounded replacement. |
| [Go · x/sync](https://github.com/golang/sync/tree/913fb63af28f446cd10c684ee847b5606cf328f7) | In 22 tracked files, a source preview found `semaphore/semaphore.go`. The reference patch added a negative-weight guard. The semaphore suite and an added regression check passed. Bonsai omitted the guard on two prompts. The model-mode oracle rejected both outputs before staging. |
| [Rust · ripgrep](https://github.com/BurntSushi/ripgrep/tree/4649aa9700619f94cf9c66876e9549d83420e16c) | In 213 tracked files, the source-preview fallback put `crates/globset/src/lib.rs` in the delivered packet despite a higher-ranked README. The reference replacement and Bonsai replacement matched the intended diff. Verification covered retrieval, stale-base rejection and exact write. Cargo compilation was outside this run. |

Run `scripts/verify-oss.sh` after building the extension. It checks pinned revisions before making changes in disposable clones. The default run uses known reference edits to isolate harness behavior. With the local MLX server for the tested checkpoint running on port 38694, `CONTEXO_TEST_BONSAI=1` tests model-generated single-line replacements against the same oracle. It reports rejected responses and exits nonzero if any proposal was rejected. `CONTEXO_TEST_RUST=1` also runs the globset package tests when Cargo is available.

Release acceptance still includes a full model-driven 100-file migration across dependency edges and tests, forced runtime compaction with pinned invariants, a signed-in Copilot run, and Rust build verification. The 120-file probe measures state pagination, not model edit quality. The native editor test exercises trusted-workspace controls and synthetic failure routing. It does not establish enterprise deployment readiness.

## Bonsai on upstream Flask

A fresh clone of [Flask 3.1.3](https://github.com/pallets/flask/tree/22d924701a6ae2e4cd01e9a15bbaf3946094af65) had 235 tracked files. The Task B prompt named the behavior, coverage and docs without specifying paths. The packaged Contexo CLI registered its actual MCP tools with isolated TrueForge 0.185.1. The same local Bonsai 4B weights ran with MLX and the verified packing compatibility described above.

| Run | What TrueForge and Contexo observed |
| --- | --- |
| Production tool profile | Bonsai printed a request to look up a nonexistent `flask.config` tool. The reply was plain text. Zero tools ran and the checkout stayed clean. |
| Focused profile with preloaded tools | The model named `assemble_context` but emitted an unstructured envelope with invalid JSON arguments. Zero tools ran. |
| Experimental normalization of tool envelopes | A loopback adapter normalized one complete, valid model-authored `assemble_context` envelope to a structured call and TrueForge dispatched it. Retrieval found `FlaskGroup` registration and the CLI tests. After receiving the packet the model printed a malformed, implementation-only `propose_write` request before any exact reads. The adapter did not promote it. Additional narrowed-tool testing recovered context again and hit a provider response timeout. No proposal reached review and no files changed. This adapter was an evaluation tool outside the extension. |
| Fixed small-budget retrieval | The initial 1,800-source-token packet used 1,752 estimated source tokens and 3,032 estimated total tokens. It included the implementation and tests but selected the changelog in place of the CLI guide. The repeatable OSS test now delivers `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst` and lists all three in the file map. The rerun used 1,782 estimated source tokens and 2,767 estimated total tokens. |
| Independent competition acceptance | Reapplied the previously recorded A and B patches to separate pinned checkouts and ran `scripts/verify-flask.sh`. A printed `False` for `FLASK_DEBUG=off`. B passed 60 tests, appeared in help, masked all four sample key classes and preserved the public value. The C checkout stayed clean. A new packaged editor fixture independently exercised automatic fallback, context delivery, checkpoint lookup, and a reviewed write. These checks do not imply Bonsai completed Task B. |

Repeat the retrieval and exact-change checks with `scripts/verify-oss.sh`. The new AST regression covers a direct imported alias, a module alias, competing same-named implementations and the associated caller and test. The exact-read regression verifies CRLF and serialization bounds. Dynamic dispatch and re-export traversal remain outside those checks.

## Spawned agent and panel review

A second agent exercised the packaged VS Code Contexo MCP bridge against a separate clean Flask 3.1.3 checkout. It assembled context, searched for the CLI tests, read current source and hashes, and submitted one three-file proposal. The checkout stayed clean until the agent used the native review controls. Accept and Apply wrote six hunks, totaling 55 insertions across implementation, tests and documentation. All 60 CLI tests passed, help listed the command, and independent checks masked the four requested key classes and a mixed-case key while preserving the public value. The isolated Claude Code profile required login and dispatched zero tools. The successful run used the spawned agent directly through Contexo.

The repeatable OSS check now covers both the Bonsai and spawned-agent prompts, at 1,800 and 2,200 estimated source-token budgets. Both include the CLI implementation, CLI tests and CLI guide in the delivered excerpts and in the file map. The 2,200-token run used about 2,166 source tokens and 3,332 packet tokens.

The built panel was exercised at 340 pixels with simulated host messages in Chrome. The check covered Markdown headings, emphasis, tables, fenced code, a workspace source link, rejected executable links and remote images, session filters, tool expansion, turn selection, context filtering, and settings groups. The final package was also checked in an isolated VS Code extension host using a deterministic TrueForge model.

## Natural-repository and near-limit Bonsai probe

The upstream checkouts held 2,455 tracked files in [LMCache](https://github.com/LMCache/LMCache/tree/243f95a64c1b2e7d6815e3bc74f7bc7093221f75) and 125 in [HTTPX](https://github.com/encode/httpx/tree/26d48e0634e6ee9cdc0533996db289ce4b430177).

- **LMCache native agent.** The five-file task was to add a positive, finite request timeout to the two read-only quota commands while preserving the 10-second default. Bonsai wrote an `assemble_context` request with budget 32,000 as assistant text; TrueForge dispatched zero tools.
- **LMCache retrieval.** The filename-free packet sent 12 of 34 packed excerpts within 21,794 serialized characters and missed all five intended file roles. A separate feature-path lookup and explicit anchors delivered the handlers, helper, tests and user guide under the same cap.
- **LMCache one-request diagnostics.** The checkpoint has a 32,768-token window. MLX processed 29,693 input tokens with 3,072 reserved for output. After 588.4 seconds, the model returned six no-op edits, including invented Python paths under the docs tree, and skipped the helper and tests. An anchored run around 11,400 input tokens used its full output budget reproducing one doc block and returned incomplete JSON. Both proposals were rejected before staging. The original quota suite passed 41 tests.
- **HTTPX comparison.** The initial packet selected the CLI module but the serialized response omitted it. An assisted 6,261-input-token call got the CLI, tests and timeout guide and returned a plausible summary. All seven edit entries were unchanged, and the proposal skipped the intended CLI tests. The original CLI accepted a zero timeout in the independent oracle. No model proposal was staged or applied.

The higher-context diagnostics ran directly against local MLX using the actual Contexo packet and explicitly logged supplemental source. They isolate model behavior from native tool dispatch. The original checkouts stayed clean. No diagnostic exposed a separate reasoning block.

## Retrieval and range-edit follow-up

The same filename-free task requests ran against the same clean upstream revisions. The app's assembler, Git file map and MCP serializer ran together with a 32,000-source-token request. The table counts distinct required files whose source excerpts and file-map entries both survived serialization. Token counts are estimates for the packet itself.

| Repository | Required files delivered | Sources / total tokens | Serialized characters |
| --- | --- | --- | --- |
| LMCache | 5/5. Quota get and list handlers, shared helper, quota HTTP tests and quota user guide. The original automatically delivered source missed these five roles. | 3,483 / 5,277 | 21,762 |
| HTTPX | 3/3. CLI implementation, CLI tests and timeout guide. The earlier serialized response omitted the CLI implementation. | 3,636 / 5,441 | 21,759 |

A separate cache microbenchmark reused the actual 24,952-symbol LMCache index. For the same request, 12 forced misses with fresh array identities and 12 warm lookups on one snapshot produced the same ordered excerpt IDs. Forced-miss p50 was 3,736 ms and warm p50 was 118 ms. Their p95 values were 4,119 ms and 140 ms. Timing includes in-memory context assembly and excludes index parsing, live search, Git, MCP and inference. These measurements compare warm reuse with rebuilding the ranking snapshot.

The packaged VS Code fixture passed a real TrueForge tool sequence of context assembly, checkpoint recovery, exact read and reviewed apply. The deterministic model used the exact line coordinates and full-file hash it received from Contexo. The source file changed through native review. Unit coverage checks disjoint edits, repeated source lines, CRLF, stale reads, overlap, no-op ranges and Git revision changes. The pinned Python, Go and Rust harness checks passed, including both filename-free Flask prompts under 2,200 source tokens. The Rust check exercised the exact diff and stale-base rejection.

These follow-up results verify context delivery and the new edit interface independently of model judgment. The live Bonsai diagnostics above remain the evidence for native Bonsai dispatch and near-window edit behavior.

[Head-to-head Mercury 3 and Bonsai 4B runs on HTTPX](model-comparison/README.md) record provider usage, exact writes, full patch scoring, and the bare-mention retrieval fix measured with an actual model-issued tool call.
