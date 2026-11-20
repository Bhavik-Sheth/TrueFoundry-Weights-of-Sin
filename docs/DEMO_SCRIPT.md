# Demo script (max 4:00)

Order is fixed by the rules: Task A, verify, Task B, verify, Task C, verify. Cut model waiting time, but never cut between giving an instruction and the diff appearing. Show the TrueForge session briefly during Task B, in Contexo's Session tab (no TrueForge UI is used anywhere in the demo).

## Checklist before recording

- [ ] Fresh Flask checkout at tag `3.1.3` (`scripts/setup-flask.*`), `git status` clean (venv excluded), the Flask folder is the open VS Code workspace.
- [ ] Venv active in the integrated terminal (`python`, `pytest`, `flask` resolve to it).
- [ ] TrueForge running (`npx @truefoundry/trueforge@latest`); connector `contexo-editor` and agents `contexo`, `contexo-fallback` registered; both models configured and working.
- [ ] Latest VSIX installed (`npm run install:local` in `extension/`), window reloaded, `contexo.devMode` OFF.
- [ ] Contexo panel open in the secondary sidebar, Context tab reachable; status bar visible.
- [ ] Contexo's Session tab reachable (it shows the TrueForge session for Task B); no TrueForge browser tab needed.
- [ ] Rehearsed: Settings -> Test resilience -> **Simulate primary model failure** and **Restore primary model**; the fallback model works.
- [ ] Rehearsed: Stop mid-generation (workspace unchanged), and Undo of an applied hunk (Changes tab).
- [ ] Copy of `scripts/demo-app.py` ready for the `flask config` check; no secrets on screen (keys, MCP token).
- [ ] Recorder set to the editor window; fonts large enough to read.

## Plan

| Time | Step | Show on screen | Proves |
|---|---|---|---|
| 0:00-0:10 | Intro | Editor with the Flask folder, Contexo panel, one caption line. | C1 |
| 0:10-0:50 | **Task A** | Open `src/flask/helpers.py`, select `get_debug_flag`, press `Ctrl+K E`, type the exact instruction, diff appears, accept per hunk, apply. | A1, A3 (streaming), B2 |
| 0:50-1:05 | Verify A | Terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` shows `False`. | A1, C1 |
| 1:05-1:15 | Undo demo | Changes tab: undo the applied hunk, show the file revert, redo it (or note it). Re-apply so Task B starts from the Task A state or `git checkout` the file. | B2 |
| 1:15-2:15 | **Task B** | Panel Chat tab, no files mentioned, send the exact instruction. Show streaming tokens, then the Context tab (chosen files and reasons, budget bar, omissions), then the multi-file diff (`cli.py`, `tests/test_cli.py`, `docs/cli.rst`); accept hunks and apply. | A2, B1, B2 |
| 1:50-2:05 | TrueForge session | Open the Session tab in the panel: the session's turns, tool calls (`assemble_context`, `read_file`, `propose_write` approval), and deferred tool loading. | B4, C1 |
| 2:05-2:15 | Stop demo (optional, fits here or in a separate short take) | Start a request, press Stop, show it ends immediately and `git status` is unchanged. | A3 |
| 2:15-2:45 | Verify B | `pytest tests/test_cli.py -q` passes; `flask --app demo-app.py config` shows masked JSON; `flask --help` lists `config`; `git status` shows at least three files. | A2, C1 |
| 2:45-3:45 | **Task C** | `git checkout .` to reset; Settings -> Test resilience -> Simulate primary model failure (banner stays visible); repeat Task A. Show the editor staying responsive, the fallback banner and the second model completing (or a clear error); the Session tab shows the sealed primary and the fallback session. Restore the primary afterwards. | B3 |
| 3:45-4:00 | Verify C | `git status` shows only the fallback result if accepted, or nothing if the run failed; closing caption. | B3, C1 |

Adjust timing to the real run; keep the total under 4:00. Record real timestamps into the scorecard in `docs/writeup.md` (every `[TODO]`).

## Notes

- Do not show API keys, the MCP token, or the `Copy MCP Connection` clipboard contents.
- If Task C should show the "no user action" fallback (10 points), make sure the fallback agent is registered and its model works before breaking the primary one.
- Re-run `git checkout .` in Flask between takes so each task starts clean.
