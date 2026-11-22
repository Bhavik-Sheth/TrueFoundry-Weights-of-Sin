---
name: pytest-testing
version: 1
when: before adding or changing tests, or running tests
---
# Writing and running pytest tests

## Placement and style
1. Find the existing test file for the module under test (usually `tests/test_<module>.py`). Add to it; create a new file only if none fits.
2. Copy the neighbouring tests: naming (`test_<behaviour>`), fixtures, parametrization, assertion style. Prefer plain `assert` and `pytest.raises(..., match=...)`.
3. Reuse fixtures from `conftest.py` before writing new ones. Use `tmp_path` for files and `monkeypatch` for env vars and attributes.
4. One behaviour per test. Cover the happy path and the most likely failure.

## Testing Click commands
1. Use `click.testing.CliRunner`:
   ```python
   from click.testing import CliRunner

   def test_hello():
       runner = CliRunner()
       result = runner.invoke(cli, ["hello", "--name", "x"])
       assert result.exit_code == 0
       assert "x" in result.output
   ```
2. Pass arguments as a list, one token per item. Assert on `result.exit_code` first, then `result.output`.
3. For errors, assert a non-zero `exit_code` and the message in `result.output`. If the output looks empty, inspect `result.exception`.
4. Use `runner.isolated_filesystem()` for commands that write files, and `input="text\n"` for prompts.

## Testing Flask CLI commands
1. Use the app's runner: `runner = app.test_cli_runner()`; then `result = runner.invoke(args=["mycommand", "--opt", "v"])`, or `runner.invoke(my_command_object, [...])`.
2. Build the `app` from the project's existing `app` fixture; do not create a second app configuration.
3. Assert on `result.exit_code` and `result.output` as above.

## Running tests
1. Run the narrowest target first with `run_command`, argv array, no shell: `["pytest", "-q", "tests/test_cli.py"]`, or one test: `["pytest", "-q", "tests/test_cli.py::test_hello"]`.
2. Use `-q` to keep output short. Add `-x` to stop at the first failure and `-k <expr>` to select by name.
3. Read the failure output. If the test fails because of your change, propose a fix. If it was failing before your change, say so and do not "fix" it.
4. After the focused run passes, run the wider test file or directory once to check for regressions.
