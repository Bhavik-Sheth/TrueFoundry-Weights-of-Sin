/**
 * context/assembler.ts - C3 budgeted hybrid retrieval (assemble_context). The core novel file.
 *
 * Exports:
 *  - assembleContext({request, mentions?, budget?, selection?, runId}): ContextPacket.
 *  - extractAnchors(request, mentions, selection): identifiers, quoted strings, CLI-ish words,
 *    capitalised constants; stopwords dropped; @path / @name mentions resolved.
 *  - expandOneHop(top10): calls/called-by, registers (@click.command, @app.cli.command,
 *    cli.add_command), tests (test_<module>.py or bodies referencing the name), documents.
 *    Each expanded item carries a Reason naming its source.
 *  - rrfFuse(lists): score = sum 1/(60 + rank_i) across BM25, symbol-name, ripgrep, docs and expansion lists.
 *  - pack(candidates, budget): mandatory (selection, mentions) first, then greedy score/tokens;
 *    merge overlapping ranges; duplicate penalty past 3 excerpts per file; coverage quota reserves
 *    best test and best doc; symbols > 30% of budget cut to signature + docstring + matching lines.
 *  - buildGraph(...): request -> terms -> files -> symbols with labelled edges (inferred flag).
 *  - formatForModel(packet): "### path:start-end . impl|test|docs . reason . ~tokens" headers + Omitted list.
 *
 * Rules: every omission carries a reason (duplicate | lower-rank | over-budget); target < 1 s at 8k budget.
 * Depends on: context/search, context/indexer, context/tokens, config, types.
 * Depended on by: mcp/tools; output consumed by shell/panel (Context tab).
 */
export {};
