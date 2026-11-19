# UPSTREAMS

Everything Contexo reuses, with provenance and licence.

## Fork point

| Field | Value |
|---|---|
| Repository | microsoft/vscode-extension-samples |
| Path | `webview-view-sample/` |
| Commit | `65c1c44800eeac6fb065a54823ee5ae62c79540a` |
| Licence | MIT (copy preserved in `extension/LICENSE.upstream`) |

What we kept from the fork: the WebviewViewProvider and CSP/nonce pattern. Everything else is ours.

## Reused npm packages

| Package | Used for | Component | Licence |
|---|---|---|---|
| `@truefoundry/trueforge-sdk` | Sessions, streams, approvals, cancel | C2 | licence: TBD-verify |
| `@truefoundry/trueforge-ui` | Chat UI in the webview | C1 | licence: TBD-verify |
| `@modelcontextprotocol/sdk` | MCP Streamable HTTP server | C3 | licence: TBD-verify |
| `diff` (jsdiff) | Hunks, patches, apply/reverse | C4 | licence: TBD-verify |
| `@vscode/ripgrep` | Lexical search, file listing | C3 | licence: TBD-verify |
| `web-tree-sitter` + `tree-sitter-python.wasm` | Python parsing, symbol check | C3/C4 | licence: TBD-verify |
| `@xyflow/react` | Context graph | C1 | licence: TBD-verify |
| `zod` | MCP tool input schemas | C3 | licence: TBD-verify |
| `js-tiktoken` | Token estimates (cl100k_base) | C3 | licence: TBD-verify |
| `tree-kill` | Killing run_command process trees | C3 | licence: TBD-verify |

## Test target

| Repository | Ref | Licence |
|---|---|---|
| pallets/flask | tag `3.1.3` (`22d92470`) | licence: TBD-verify |
