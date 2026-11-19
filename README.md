# Contexo

Contexo is a VS Code extension that adds a context-aware coding agent to the editor. Its agent loop runs entirely on [TrueForge](https://github.com/truefoundry/trueforge) (TrueFoundry's open-source agent harness) in local mode. Built for the TrueFoundry Forge-a-thon.

- **Inline edit**: select code, press `Ctrl+Alt+E` (`Cmd+Alt+E` on macOS), type an instruction, review the diff hunk by hunk.
- **Agent mode**: a panel in the secondary sidebar (Chat / Context / Changes tabs) where one request drives a multi-file change. The agent finds the files itself.
- **Context assembly**: `@file` / `@symbol` mentions plus automatic budgeted retrieval, with reasons and omissions visible in the Context tab.
- **Safe review**: nothing is written until you accept; every hunk has Accept/Reject CodeLens; applied hunks can be undone.
- **Streaming, Stop, fallback**: tokens stream in; Stop is immediate and leaves the workspace untouched; if the primary model fails, a second configured model takes over.

The extension never calls a model provider. It is a client of a TrueForge agent and exposes the editor to that agent as MCP tools. Models and keys live only in TrueForge.

## Quick start (just use it)

1. Get `contexo.vsix` (build it with the steps below, or download it from the repository's releases if one is published).
2. In VS Code: **Extensions → ⋯ → Install from VSIX…** and pick the file (or `code --install-extension contexo.vsix`).
3. Open any project folder and click the **Contexo** icon in the secondary sidebar. The setup wizard starts TrueForge, takes your provider API key, lets you pick a primary and a fallback model, and registers the agents. No terminal and no TrueForge UI needed.
4. Select code and press `Ctrl+Alt+E` for an inline edit, or type a request in the Chat tab for agent mode.

You need Node.js 22.14+ installed (Contexo uses it to run TrueForge locally) and an API key for at least one model provider.

## Requirements

- VS Code 1.90 or newer (with the `code` command on PATH for `npm run install:local`)
- Node.js 22.14 or newer (TrueForge requires it) and npm
- Python 3.10+ and git (to prepare the Flask test repository)
- A model API key (or a local OpenAI-compatible endpoint) configured inside TrueForge

## Setup from a clean clone

1. Clone this repository, then prepare the demo target (Flask 3.1.3 in a sibling `flask/` folder, with a venv):

   ```powershell
   # Windows
   powershell -File scripts/setup-flask.ps1
   ```
   ```bash
   # macOS / Linux
   scripts/setup-flask.sh
   ```

   Both scripts clone `pallets/flask`, check out tag `3.1.3`, create `.venv`, install Flask in editable mode and the test dependencies, and add `.venv/` to the clone's `.git/info/exclude` so the demo repo stays clean. They pin `pytest<9` because Flask 3.1.3's tests import `_pytest.monkeypatch.notset`, which pytest 9 removed.

2. Build and install the extension:

   ```bash
   cd extension
   npm ci
   npm run install:local   # builds, runs the provider check, packages dist/contexo.vsix, installs it
   ```

3. Open the Flask folder in VS Code. The Contexo panel (secondary sidebar) opens a **setup wizard** the first time; no terminal and no TrueForge UI needed:

   1. **TrueForge**: Contexo starts a local TrueForge for you (`npx @truefoundry/trueforge@latest`, needs Node 22.14+; the first run downloads it and can take a minute). If it is already running, Contexo uses it and never stops it.
   2. **Add provider**: pick a provider, paste its API key, press **Save to TrueForge**. The key is sent once to your local TrueForge's own API and is not kept by Contexo (no settings, no secret storage, no logs).
   3. **Choose models**: pick a primary and a fallback model (ideally different providers).
   4. **Register**: one click creates the `contexo-editor` connector and the `contexo` / `contexo-fallback` agents in TrueForge.
   5. **Done**: the tabs open. The gear tab (**Settings**) keeps the same controls plus health checks; **Contexo: Open Setup** reopens the wizard.

   Settings added: `contexo.autoStartTrueForge` (default `true`), `contexo.primaryModel`, `contexo.fallbackModel` (model names only).

### Manual alternative (no wizard)

Use this if you prefer the terminal or the TrueForge UI.

1. Start TrueForge yourself (leave it running): `npx @truefoundry/trueforge@latest` (http://localhost:8790; `--port <n>` or `PORT` to change). Set `contexo.autoStartTrueForge` to `false` to stop Contexo from starting one.
2. In the TrueForge UI, open **Settings -> Models** and configure two models (a primary and a fallback, ideally from different providers). See [extension/trueforge/models.example.md](extension/trueforge/models.example.md). Never commit keys.
3. Run **Contexo: Copy MCP Connection** from the Command Palette (copies the MCP URL and the `X-Contexo-Token`).
4. Register the connector and agents (from `extension/`):

   ```bash
   CONTEXO_TOKEN=<token>    PRIMARY_MODEL=<provider>/<primary model>    FALLBACK_MODEL=<provider>/<fallback model>    node trueforge/register.mjs
   ```

   PowerShell: `$env:CONTEXO_TOKEN='...'; $env:PRIMARY_MODEL='...'; $env:FALLBACK_MODEL='...'; node trueforge/register.mjs`.

   Required env vars: `CONTEXO_TOKEN`, `PRIMARY_MODEL`, `FALLBACK_MODEL`. Optional: `TRUEFORGE_URL` (default `http://localhost:8790`), `CONTEXO_PORT` (default `8791`, must match `contexo.mcpPort`). Existing resources with the same name are left alone; the wizard's Register button updates them instead. Agent definitions are in [extension/trueforge/](extension/trueforge/).

5. Reload the VS Code window. The Contexo icon appears in the secondary sidebar; the status bar shows the run state.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `contexo.trueforgeUrl` | `http://localhost:8790` | TrueForge local server URL |
| `contexo.primaryAgent` | `contexo` | Primary TrueForge agent name |
| `contexo.fallbackAgent` | `contexo-fallback` | Fallback agent name |
| `contexo.excerptBudget` | `8000` | Token budget for assembled excerpts |
| `contexo.firstEventTimeoutMs` | `20000` | Wait for the first stream event before treating the model as failed |
| `contexo.commandAllowlist` | `["python","pytest","flask"]` | Allowed `argv[0]` values for `run_command` |
| `contexo.mcpPort` | `8791` | Fixed port of the local Contexo MCP server |
| `contexo.autoStartTrueForge` | `true` | Start a local TrueForge when none is running |
| `contexo.primaryModel` / `contexo.fallbackModel` | empty | `provider/model` names chosen in the wizard (never keys) |
| `contexo.devMode` | `false` | Show the dev/fixture commands in the Command Palette |

## Commands

`Contexo: Inline Edit` (`Ctrl+Alt+E`, needs a selection), `Contexo: Open Setup`, `Contexo: Stop`, `Contexo: Copy MCP Connection`, `Contexo: Reindex Workspace`, and the review commands used by the CodeLens and the Changes tab (`Undo Hunk`, `Redo Hunk`, `Decide Hunk`, `Apply Accepted Hunks`, `Accept All Hunks`, `Reject All Hunks`; hidden from the palette). With `contexo.devMode` on: `Contexo Dev: Ping TrueForge`, `Send Test Turn`, `Show Sample Context Packet`, `Open Sample Proposal` (and a missing-symbol variant), `Apply Sample Change`.

## Running the three fixed tasks (Flask 3.1.3)

Open the `flask/` folder (checked out at `3.1.3`, clean `git status`) in VS Code, with TrueForge running and the agents registered.

**Task A: inline edit.** Open `src/flask/helpers.py`, select the function `get_debug_flag`, press `Ctrl+Alt+E` and enter exactly:

> Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.

Review the diff (per-hunk CodeLens), accept, apply. Verify (from the Flask directory, venv active):

```bash
FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"   # prints False
```

PowerShell: `$env:FLASK_DEBUG='off'; python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`.

**Task B: agent mode.** In the Contexo panel (Chat tab), with no files mentioned, send exactly:

> Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.

Watch the Context tab (chosen files and reasons), review and accept the hunks (expect `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst`), and open the TrueForge session ("Open in TrueForge" link in the Chat tab, or the TrueForge UI at `http://localhost:8790`) to show turns and tool calls. Verify:

```bash
pytest tests/test_cli.py -q
flask --app <some app> config      # masked JSON; e.g. copy scripts/demo-app.py into the Flask folder (outside git status) and use --app demo-app.py
```

**Task C: resilience.** In the TrueForge UI (**Settings -> Models**, or **Open TrueForge** from Contexo's Settings tab) break the primary model (invalid key or unreachable endpoint), then repeat Task A. Contexo shows a banner and the fallback agent takes over automatically (or a clear error if both fail). Verify the editor stays responsive and `git status` in Flask shows no changes.

See [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) for the recording plan.

## Switching models

Open the **Settings** (gear) tab in the Contexo panel and pick a different primary or fallback model. Contexo updates the `contexo` / `contexo-fallback` agents in TrueForge right away. To use a new provider, add its key in the same tab first. No extension change or rebuild is needed.

Models and keys still live only in TrueForge, so you can also change them in the TrueForge UI (Build Agent), re-run `register.mjs` with different `PRIMARY_MODEL` / `FALLBACK_MODEL`, or point `contexo.primaryAgent` / `contexo.fallbackAgent` at other agents.

## Development

```bash
cd extension
npm ci
npm run watch        # esbuild watch for the extension host; press F5 for an Extension Development Host
npm run watch:web    # vite watch for the webview
npm run typecheck
npm test             # vitest
npm run package      # build + provider check + dist/contexo.vsix
npm run install:local
```

`npm run check` greps the built bundle for provider SDKs/URLs and fails if any are found (the extension must not call a model directly).

## Declared fork point

| Field | Value |
|---|---|
| Upstream | https://github.com/microsoft/vscode-extension-samples |
| Path | `webview-view-sample/` |
| Commit | `65c1c44800eeac6fb065a54823ee5ae62c79540a` |
| Licence | MIT, preserved in `extension/LICENSE.upstream` |

Details and all other dependencies with licences: [UPSTREAMS.md](UPSTREAMS.md).

### What we changed and why

The upstream sample is a minimal webview view with colour-picker commands and no agent. Only the `WebviewViewProvider` shape, the CSP meta tag and `getNonce()` were taken (`extension/src/shell/panel.ts`). Everything else is ours:

- **Agent loop on TrueForge** (`src/run/`): sessions and turns through the TrueForge SDK, event streaming, tool approvals, Stop, and automatic fallback to a second agent. No upstream loop exists.
- **Editor capabilities as MCP tools** (`src/mcp/`): a local Streamable HTTP MCP server (127.0.0.1, token header) exposing `search_workspace`, `read_file`, `assemble_context`, `list_symbols`, `propose_write` and `run_command`, so the agent decides what to read and change.
- **Context assembly** (`src/context/`): Tree-sitter symbol index, BM25 / symbol / ripgrep retrieval, one-hop expansion, RRF fusion and budgeted packing with reasons and omissions.
- **Review and undo** (`src/review/`): `propose_write` is approval-gated; the proposal is shown as per-hunk diffs with CodeLens, guarded (stale base, scope, missing symbols), applied only after accept, and undoable per hunk or per apply.
- **Setup without a terminal** (`src/run/trueforgeProcess.ts`, `src/run/trueforgeAdmin.ts`, `src/shell/setup*.ts`): starts a local TrueForge, forwards the provider key to TrueForge's API, lists models, and registers the connector and agents.
- **UI** (`webview/`): setup wizard, Chat, Context (graph and ranked list), Changes and Settings tabs.

## Project layout

```text
extension/
  src/extension.ts        activation and wiring
  src/shell/              panel, inline edit command, status bar, setup state + controller
  src/run/                RunManager, TrueForge client wrapper, fallback, TrueForge auto-start + admin, agent manifests
  src/mcp/                MCP server, tool registration, run_command
  src/context/            indexer, search (BM25, ripgrep), assembler, token counts
  src/review/             proposal/hunks, guards, diff view + CodeLens, apply/undo
  src/dev/                fixtures and dev commands
  webview/                React webview (setup wizard, Chat, Context, Changes, Settings)
  trueforge/              agent JSONs, connector JSON, instructions.md, register.mjs, models.example.md
  test/                   Vitest suites
scripts/                  setup-flask.{ps1,sh}, check-no-provider.mjs, demo-app.py
docs/                     plan, PRD, contracts, spike notes, write-up, demo script
UPSTREAMS.md              provenance and licences
```

## Docs

- [docs/PRD_Lite.md](docs/PRD_Lite.md): scope and design
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): slices and manual scripts
- [docs/spike-notes.md](docs/spike-notes.md): TrueForge findings and open questions
- [docs/writeup.md](docs/writeup.md): submission write-up
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md): demo recording plan

## Licence

MIT (see `LICENSE`); the upstream sample's MIT licence is kept in `extension/LICENSE.upstream`.
