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

Versions are the exact pins in `extension/package.json` / `package-lock.json`. Licences were checked with `npx license-checker --production --summary` in `extension/` (see the transitive summary below) and, for `tree-sitter-python` (dev dependency, only its `.wasm` is shipped), from `node_modules/tree-sitter-python/LICENSE`.

| Package | Version | Used for | Component | Licence |
|---|---|---|---|---|
| `@truefoundry/trueforge-sdk` | 0.185.0 | Sessions, streams, approvals, cancel; also used by `trueforge/register.mjs` | C2 | MIT |
| `@truefoundry/trueforge-ui` | 0.185.1 | Declared dependency for the chat UI; the current webview renders host-relayed events itself and does not import it (see `docs/spike-notes.md` Q5) | C1 | MIT |
| `@modelcontextprotocol/sdk` | 1.32.2 | MCP Streamable HTTP server | C3 | MIT |
| `diff` (jsdiff) | 9.0.0 | Hunks, patches, apply/reverse | C4 | BSD-3-Clause |
| `web-tree-sitter` | 0.27.2 | Python parsing, symbol check (runtime + `web-tree-sitter.wasm`) | C3/C4 | MIT |
| `tree-sitter-python` | 0.25.0 | Python grammar (`tree-sitter-python.wasm` copied into `dist/`) | C3/C4 | MIT |
| `@xyflow/react` | 13.0.2 | Context graph | C1 | MIT |
| `react`, `react-dom` | 19.3.1 | Webview UI | C1 | MIT |
| `zod` | 4.6.7 | MCP tool input schemas | C3 | MIT |
| `js-tiktoken` | 1.0.21 | Token estimates (cl100k_base) | C3 | MIT |
| `tree-kill` | 1.2.2 | Killing run_command process trees | C3 | MIT |

Lexical search uses the `rg` binary bundled with VS Code (falling back to `rg` on PATH). `@vscode/ripgrep` is NOT a dependency of this project.

### Transitive production dependencies

`license-checker --production --summary` (extension/): MIT 378, ISC 27, BSD-3-Clause 7, BSD-2-Clause 2, Apache-2.0 1 (`@truefoundry/trueforge-assistant-ui-runtime`), `(MPL-2.0 OR Apache-2.0)` 1 (`dompurify`), CC0-1.0 1 (`highlightjs-vue`), 0BSD 1 (`tslib`), `MIT AND ISC` 1 (`victory-vendor`), `MIT*` 1 (`@ag-ui/core` 0.0.53: no `license` field in its package.json; its LICENSE file is the MIT text). All are permissive and compatible with this project's MIT licence. Dev-only tooling (vite, vitest, esbuild, typescript, vsce, ...) is not shipped in the VSIX.

## Test target

| Repository | Ref | Licence |
|---|---|---|
| pallets/flask | tag `3.1.3` (`22d92470`) | BSD-3-Clause |

Flask is cloned separately by `scripts/setup-flask.*`; no Flask code is vendored in this repository.
