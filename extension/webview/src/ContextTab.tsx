/**
 * ContextTab.tsx - Context tab list view (C1, serves criterion B1).
 *
 * Exports:
 *  - ContextTab (React component): shows the latest ContextPacket: excerpt list (path:lines,
 *    category chip impl/test/docs, reasons, ~tokens; click posts openSource); an Omitted section
 *    with a reason per drop (duplicate / lower-rank / over-budget); budget bar showing
 *    used versus excerpt budget; embeds ContextGraph.
 *  - BudgetBar, ExcerptRow, OmittedList (small inner components).
 *
 * Depends on: bridge.ts, ContextGraph.tsx. Depended on by: App.tsx.
 */
export {};
