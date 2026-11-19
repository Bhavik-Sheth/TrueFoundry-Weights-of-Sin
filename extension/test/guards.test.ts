/**
 * guards.test.ts - tests for src/review/guards.ts (C4).
 *
 * Cases to write:
 *  - Missing symbol detected: call to an undefined bare name reports MISSING_SYMBOL name @ path:line.
 *  - Builtins, imports, locals, parameters and defs added in the same proposal pass.
 *  - Names known in the workspace index and importable pass.
 *  - Star-import tolerated (unknown-but-allowed, no denial).
 *  - Attribute calls are skipped; decorator names are checked.
 *  - Scope guard flags hunks outside the selection range, including after line-delta adjustment
 *    from hunks above; hunks inside the selection are not flagged.
 */
export {};
