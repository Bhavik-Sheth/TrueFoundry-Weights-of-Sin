# Contexo write-up

## 1. Team
Names, roles, who owned which component (C1 to C4).

## 2. Starting point
Fork point (repo, path, commit, MIT), what was reused vs written by us, and what existed before the hackathon.

## 3. Architecture on TrueForge
How the extension is a client and MCP server of TrueForge: sessions, approvals, deferred tool loading, Stop, fallback. Include the component diagram and video timestamps.

## 4. How context is selected
The assemble_context strategy: anchors, BM25 + symbol + ripgrep + docs lists, one-hop expansion, RRF, budgeted packing, coverage quota, reasons and omissions. Link to the Context tab in the video.

## 5. Model setup
How the primary and fallback models are configured in TrueForge only (no keys in the repo), and how failover is triggered.

## 6. Scorecard
Self-assessment per criterion (A1 to C2) with evidence and video timestamps.

## 7. Tools used
Libraries, AI assistants, and services used, with licences where relevant.

## 8. Known limitations
Honest list: run_command on host, one approval per propose_write, in-memory undo, estimated token counts, lexical symbol check.
