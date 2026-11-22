---
name: python-editing
version: 1
when: before writing or changing Python source code
---
# Editing Python safely

1. Read before you write. Use `read_symbol` or `read_file` on the exact function or class you will change. Never edit from memory.
2. Make the smallest diff that satisfies the request. Replace only the lines that must change. Do not reformat, reorder, rename or "tidy" code you were not asked to touch.
3. Match the file's existing style: quote style, line length, indentation, naming, type-hint usage, string formatting (f-strings vs `.format`), and docstring convention (Google, NumPy or reST; copy the neighbouring functions).
4. Imports:
   - Add a new import only if the code needs it. Put it in the existing import block, in the same grouping order (stdlib, third party, local) and sorting as the file.
   - Reuse names already imported instead of importing the same thing a second way.
   - Never leave an import unused after your edit; remove only imports your change made unused.
   - Verify with `list_symbols` or `search_workspace` that anything you import or call exists, and check its real signature.
5. Docstrings and comments:
   - If you add a public function, class or CLI command, give it a docstring in the style of its neighbours. For Click commands the docstring is the `--help` text, so keep it one short imperative sentence.
   - If you change behaviour, update that function's docstring and any comment that is now false.
   - Do not add comments that restate the code.
6. Keep public signatures, return types and error behaviour stable unless the request says otherwise. When you must change one, search for every caller and update them in the same proposal.
7. Do not touch unrelated code: no drive-by fixes, no deleting dead code, no changing other files "for consistency". Mention unrelated problems in your reply instead.
8. Preserve the file's line endings and trailing newline.
9. Use `propose_write` once with every edit for the change. Then run the relevant tests with `run_command` and read the output.
