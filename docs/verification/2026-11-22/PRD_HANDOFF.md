# PRD backlog Tasks 13–15 verification

The VS Code Extension Development Host ran on Flask 3.1.3 at `22d9247`. An isolated TrueForge runtime replayed the recorded Task A and B patches with a scripted local model. The history case added one fixture commit to the disposable checkout. Native diff CodeLens was enabled for that checkout.

| Check | Observed result |
| --- | --- |
| Index and Diagnostics | Reindexed 165 files. Settings showed a 219.3 ms full index, 21.1 ms event-loop p50, and 21.2 ms p95. Stopping a pending review recorded 4.1 ms in the extension log. |
| History guard | The first proposal was denied with `HISTORY_CONCERN`. The retry showed the concern CodeLens. Accept all left the hunk pending, and individual Accept opened a confirmation. |
| Regenerate | A source edit made the open Task A review stale. Apply returned `STALE_BASE`, and Regenerate opened a fresh proposal. |
| Changes | Task B showed a three-file summary and wiring graph. A summary fact opened `src/flask/cli.py`, an edge opened `tests/test_cli.py`, and applying cleared the graph. |
| Task | All five requirements advanced from proposed to applied to checked after the approved, deferred pytest call. The Flask CLI suite passed all 60 tests. |
| Mentions | Typing `@get_deb` showed `get_debug_flag` first. Enter inserted it, and its excerpt displayed the mention as the first reason. |
| Undo | Undo hunk previewed and applied a clean three-way merge while preserving a nearby edit. Undo Run reverted all three Task B files, which matched the repository baseline afterward. |
| Startup recovery | A temporary build terminated the Extension Host after saving the first of three reviewed files. The regular build offered Recover on restart. All three files matched the reviewed patch after recovery, and the Flask CLI tests passed. |
| Explorer | The extension registered the updated instructions with the local TrueForge runtime. No explorer thread was observed in the scripted replay. Mercury was unavailable for this check. |

The branch review fixed stale Task-tab updates, missing explicit mention anchors, misleading command facts, duplicate recovery prompts, and Git environment handling for history and merge previews. Deferred items include history matching precision, partial instruction-pack availability, multi-file regeneration, wiring attribution, snapshot size and new-file undo, preview-tab cleanup, and startup journal scan cost.
