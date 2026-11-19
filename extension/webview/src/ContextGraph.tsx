/**
 * ContextGraph.tsx - React Flow graph of the context choice (C1; cut candidate, list is kept).
 *
 * Exports:
 *  - ContextGraph (React component): renders packet.graph with @xyflow/react using fixed columns
 *    request, terms, files, symbols (no layout library, stable positions). Edge labels are
 *    the reasons (lexical, registers, tests, docs); dashed edges = inferred; node click
 *    posts openSource. Node positions can be stored via setState.
 *
 * Depends on: @xyflow/react, bridge.ts, ContextPacket graph type. Depended on by: ContextTab.tsx.
 */
export {};
