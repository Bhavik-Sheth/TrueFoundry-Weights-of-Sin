# UPSTREAMS

Everything Contexo reuses, with provenance and licence.

## Fork point

| Field | Value |
|---|---|
| Repository | microsoft/vscode-extension-samples |
| Path | `webview-view-sample/` |
| Commit | `65c1c44800eeac6fb065a54823ee5ae62c79540a` |
| Licence | MIT (copy preserved in `extension/LICENSE.upstream`) |

Commit verified present (`65c1c44 Remove dead code (#1181)`). Adapted into `extension/src/shell/panel.ts`: the `WebviewViewProvider` shape (`resolveWebviewView`, `webview.options` with `localResourceRoots`, `asWebviewUri` for assets), the CSP meta tag and the `getNonce()` helper. Not taken: the sample's `media/` files, colour-picker commands and message handling. Everything else is ours.

## Reused npm packages

| Package | Used for | Component | Licence |
|---|---|---|---|
| `@truefoundry/trueforge-sdk` | Sessions, streams, approvals, cancel | C2 | licence: TBD-verify |
| `@truefoundry/trueforge-ui` | Chat UI in the webview | C1 | licence: TBD-verify |
| `@modelcontextprotocol/sdk` | MCP Streamable HTTP server | C3 | licence: TBD-verify |
| `diff` (jsdiff) | Hunks, patches, apply/reverse | C4 | licence: TBD-verify |
| `@vscode/ripgrep` | Lexical search, file listing | C3 | licence: TBD-verify |
| `web-tree-sitter` 0.27.2 + `tree-sitter-python` 0.25.0 (`tree-sitter-python.wasm`) | Python parsing, symbol check | C3/C4 | licence: TBD-verify |
| `@xyflow/react` | Context graph | C1 | licence: TBD-verify |
| `zod` | MCP tool input schemas | C3 | licence: TBD-verify |
| `js-tiktoken` | Token estimates (cl100k_base) | C3 | licence: TBD-verify |
| `tree-kill` | Killing run_command process trees | C3 | licence: TBD-verify |

## Test target

| Repository | Ref | Licence |
|---|---|---|
| pallets/flask | tag `3.1.3` (`22d92470`) | licence: TBD-verify |
