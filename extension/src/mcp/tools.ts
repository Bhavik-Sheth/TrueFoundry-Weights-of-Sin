/**
 * mcp/tools.ts - C3 zod schemas and handlers for the 6 editor tools (PRD_Lite 9.3).
 *
 * Exports:
 *  - registerTools(server, deps): search_workspace {query,glob?,limit<=30}; read_file
 *    {path,startLine?,endLine?} -> {path,text,hash,totalLines,truncated} (dirty buffer first);
 *    assemble_context {request,mentions?,budget?} (also pushes packet+graph to the panel);
 *    list_symbols {path?,query?} (deferred); propose_write {summary,edits[]} (approval-gated;
 *    computes proposal key from args -> review.finalize(key) -> {applied,rejected,files});
 *    run_command {argv,timeoutSec<=180} (deferred, approval; delegates to runCommand).
 *
 * Rules: tool descriptions tell the agent to call assemble_context before editing and to use
 * read_file hashes as baseHash. propose_write never writes by itself; unknown key -> error, no write.
 * Depends on: context/*, review/diffView, mcp/runCommand, shell/panel, zod.
 * Depended on by: mcp/server.
 */
export {};
