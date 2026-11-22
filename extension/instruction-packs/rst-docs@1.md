---
name: rst-docs
version: 1
when: before adding or editing reStructuredText (.rst) documentation
---
# Editing reStructuredText docs

## Find where it belongs
1. Search the docs (`search_workspace` on `docs/`) for sibling entries before writing. Documentation for a built-in CLI command belongs on the page that already lists the other built-in commands, typically a CLI page such as `docs/cli.rst`.
2. Open that page and read how an existing command is documented. Copy its pattern exactly: heading level and underline character, the directive used (for example `.. click:: module:command` with `:prog:` and `:nested:` options, or `.. program:: name` / `.. option:: --flag`), blank-line layout and indentation (3 spaces under directives).
3. Place the new entry where it fits the page's order (alphabetical, or grouped like its neighbours).

## Write the entry
1. Add a heading with the same underline character as sibling headings, with the underline at least as long as the title.
2. Use the same inline markup as the page: double backticks for literals, `:option:` roles for flags, `:func:` / `:class:` / `:meth:` roles for API references, `.. code-block:: console` for shell examples with the same prompt style as the page.
3. Describe what the command does in one or two imperative sentences, then show a short usage example and list options only if siblings do.
4. If the page has a toctree or a table of commands, add the new entry there too.
5. If the project keeps a changelog (`CHANGES.rst`), add one line in its existing format under the unreleased section.

## Check
1. Keep lines wrapped like surrounding text; never leave trailing whitespace; end the file with a newline.
2. Make sure directives have a blank line after them and consistent indentation, since rst breaks silently on both.
3. Do not edit unrelated sections of the page.
