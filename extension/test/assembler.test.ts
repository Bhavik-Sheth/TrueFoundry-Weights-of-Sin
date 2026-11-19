/**
 * assembler.test.ts - tests for src/context/assembler.ts (C3).
 *
 * Cases to write:
 *  - RRF ordering: a candidate ranked well in several lists beats one ranked top in a single list.
 *  - Budget respected: used <= budget at 8k and at small budgets; mandatory items first.
 *  - Coverage quota reserves one test excerpt and one doc excerpt when either scored.
 *  - Omissions carry reasons (duplicate | lower-rank | over-budget) and tokens.
 *  - Overlapping ranges merge; duplicate penalty after 3 excerpts from one file.
 *  - Oversized symbol (over 30 percent of budget) is cut to signature + docstring + matching lines.
 *  - Anchor extraction: identifiers, quoted strings, CLI words, capitalised constants, stopwords dropped.
 *  - Expansion reasons name their source (registers / tests / documents).
 *  - Graph nodes and edges present with labels; latency < 1 s on a Flask-sized fixture.
 */
export {};
