# Forge-a-thon submission and release verification

Checked on 22 November 2026 (IST) against the original six-page problem statement. The target is Flask 3.1.3 at `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. The README declares the upstream fork point, includes a clean-clone setup, links the example model configuration, and preserves the upstream license. TrueForge runs the agent loop. Contexo serves editor capabilities over authenticated MCP and gates edits behind native review.

## Flask fixed tasks

Three fresh disposable checkouts started from the exact pinned commit, one per task. The verifier reapplied the recorded Mercury patches for A and B. It left C untouched for an independent Git cleanliness check. This was a patch replay and behavior rerun. The original model sessions supply evidence for discovery, editing, and resilience. [Fresh command output](flask-fixed-task-recheck.txt) · [Original editor sessions](../2026-11-20/local-editor/sessions.json) · [Fixed task prompts and recording plan](../../DEMO_SCRIPT.md)

| Fixed task | Original workflow evidence | Independent recheck on 22 November |
| --- | --- | --- |
| A. Inline edit | In VS Code, the selected helper was edited through a TrueForge write approval. The recorded session finished in 3.94 seconds and changed one file. | The exact required command printed `False` for `FLASK_DEBUG=off`. A matrix also checked `0`, `FALSE`, `no`, `Off`, `N` and the empty string as false, and `1` as true. The patch treats both new values case-insensitively and lists all false values in the docstring. Git reported four additions and one deletion in `src/flask/helpers.py` alone. [A patch](../2026-11-20/local-editor/A-mercury.patch) |
| B. Agent mode | A filename-free request led the installed editor agent to the implementation, CLI tests and command guide. Its session records context assembly, search, exact reads, write approval and deferred command discovery. The editor run applied the patch and stopped at command approval. A separate terminal run iterated after a timedelta serialization failure. | `pytest tests/test_cli.py -q` passed **60/60**. Help listed `config`. An isolated Flask app returned parseable JSON with `SECRET_SAMPLE`, `DB_PASSWORD`, `ACCESS_TOKEN`, and `PRIVATE_KEY` equal to `***`, and `PUBLIC_VALUE` equal to `visible`. The accepted patch added exactly 73 lines across `src/flask/cli.py` (26), `tests/test_cli.py` (30), and `docs/cli.rst` (17). The regression tests check masked JSON, an unmasked database URL, and help registration. [B patch](../2026-11-20/local-editor/B-mercury.patch) · [Editor run counters](../2026-11-20/local-editor/sessions.json) |
| C. Resilience | The isolated editor run against the intentionally unreachable endpoint reported a readable connection error, processed nine timer ticks and issued zero tools. The source tree was clean when the run failed. A separate deterministic packaged fixture later proved automatic fallback and a reviewed write. | The clean C checkout produced empty `git status --porcelain`. Git cleanliness and UI responsiveness are distinct checks. The recorded C run is the source for responsiveness. [C editor record](../2026-11-20/local-editor/C-first.json) |

### Flask context evidence

The Task B request left all paths for the agent to discover. On the recorded editor run, the 8,000-token source allowance packed 7,112 estimated source tokens across 14 excerpts. The later pinned harness checks ran two filename-free prompt variants at 1,800 and 2,200 source tokens. Both delivered `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst` in excerpts and in the versioned file map. The lower-budget probe used 1,675 source tokens and 2,700 total estimated packet tokens. The higher-budget probe used 2,160 and 3,318. [Compact retrieval case](../2026-11-21/AGENT_BRIDGE.md#bonsai-on-upstream-flask)

## Current build and checks beyond Flask

- **Live Mercury and Bonsai comparison.** On a pinned HTTPX checkout, Mercury’s first patch passed 15 independent behavior cases but required test and doc repairs. After explicit feedback, the reviewed result passed 13 CLI tests and 1,418 upstream tests, with a shared baseline exclusion and one skip. Native Bonsai made zero tool calls on that task. [Full comparison and artifacts](../2026-11-21/model-comparison/README.md)
- **Local adapter follow-up.** A live Bonsai 4B run on the same pinned HTTPX repository used the shipping loopback adapter with a 2,048-token output cap for a shorter CLI default-timeout task. It issued a 700-token context request and read `httpx/_main.py`. The provider subsequently reported malformed tool JSON, no write reached review, and Git stayed clean. TrueForge recorded 17,895 input tokens, including 11,997 cached, and 438 output tokens. A regression now covers surfacing a provider claim of a tool call with no usable arguments as an error. This is a separate run from the earlier comparison.
- **Native packaged host.** A deterministic model emitted text envelopes through the loopback adapter. TrueForge dispatched context, checkpoint, read, batch and write tools. Native review used the returned coordinates and hash, applied the edit, and advanced the durable batch. In a separate two-root workspace with the same relative path in both folders, the selected second root changed while the first root remained byte-identical. This verifies local workspace isolation for one active run.
- **Regression coverage.** Typecheck passed and 233 tests passed with one TODO. Tests exercise dependency ordering, invalidation after a journal reopen, check-to-proposal binding, safe adapter handling of malformed/truncated tool output, chained Python re-exports, mixed decisions, stale bases, and file-history freshness. The pinned OSS checks verify Flask and Go behavior and a Rust exact diff with stale-base rejection.
- **Context benchmarks.** Filename-free probes retained 5/5 LMCache and 3/3 HTTPX required file roles in the delivered packet. The 24,952-symbol LMCache warm-ranking median was 118 ms versus 3,736 ms for a forced snapshot rebuild. That measurement excludes inference, live search and Git. [Method and results](../2026-11-21/AGENT_BRIDGE.md#retrieval-and-range-edit-follow-up)

## Submission readiness

The shipped code and the reviewed Flask behavior have evidence. The PDF keeps the eight prescribed headings, uses one scorecard table with one row per criterion, and fits three A4 pages. The 34-second checked-in reel shows selected verification footage in the A/B/C order and a TrueForge session query. It omits uninterrupted prompt-to-diff coverage, so it is useful as an evidence reel and does not satisfy the full recording requirement. Atharva’s affiliation is recorded. The other affiliations and Parvati’s GitHub handle need team confirmation.

The brief requires public GitHub, PDF and video links through the Techfest portal. On 22 November, GitHub reported this repository as private. The official Round 1 deadline was **20 November 2026, 23:59 IST**. This audit establishes the state of the prepared artifacts. It does not establish that a valid entry was previously submitted or that the portal is accepting changes. [Official competition page](https://techfest.org/competitions/forge-a-thon)

A product release still needs the 100-file forced-compaction rehearsal, a tested SSH/Codespaces run, signed-in Copilot and Claude Code edit verification, and whatever sandbox/CI accounts the team will use. The inspected local runtime had no sandbox provider or environment configured, so Skills registration and Code Mode execution remain unverified on this machine. GitHub check-run import passed typecheck. Live account verification is outstanding. [Release tracker](../../REMAINING_WORK_PLAN.md#current-implementation-and-release-gates)

## Build and reproduction

Code candidates for this audit are `ad30e91` (review, workspace, retrieval and durability) and `00d46ba` (model transport, runtime setup and CI evidence). The tested VSIX SHA-256 was `2423d92c6649497601db09837bb00908d463f8b7179e07aca39c6cf53e568a75`. The extension suite used Node 22.22.3. PDF verification checked each rendered page, the eight headings, the nine scorecard rows, the measured chart labels, and the repository-relative link targets.

From the Contexo repository root, with Chrome, VS Code, and TrueForge available:

```sh
npm --prefix extension run typecheck
npm --prefix extension test
npm --prefix extension run package
scripts/verify-oss.sh
CONTEXO_FIXTURE_MULTI_ROOT=1 CONTEXO_FIXTURE_LOCAL_ADAPTER=1 node extension/test/host/runtimeFixture.mjs
PYTHONDONTWRITEBYTECODE=1 uv run --with markdown python scripts/docs/build_writeup.py
```

For the independent fixed-task check, apply the linked A and B patches in separate clean, pinned Flask clones, keep a third clean clone for C, and run `scripts/verify-flask.sh A_CHECKOUT B_CHECKOUT C_CHECKOUT`. This does not repeat inference. For a complete rehearsal use the [recording runbook](../../DEMO_SCRIPT.md) and a verified model configured in TrueForge.
