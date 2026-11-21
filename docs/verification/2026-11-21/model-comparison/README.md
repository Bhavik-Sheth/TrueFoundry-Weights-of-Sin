# Mercury 3 and Bonsai 4B on HTTPX

Both models received the same [filename-free request](task.txt) through the shipped Contexo CLI and TrueForge 0.185.1 on separate clean clones of [HTTPX at `26d48e0`](https://github.com/encode/httpx/tree/26d48e0634e6ee9cdc0533996db289ce4b430177). The task was to validate CLI timeouts before client creation, preserve the default and valid fractions, and update tests and documentation without changing the Python API. Both runs had identical agent instructions, approval rules, tool exposure and a 40-iteration limit. The terminal reviewer accepted the model's source hunks in the disposable checkouts. Each result is a single run.

Mercury used the configured `inception/mercury-3` provider. Bonsai ran the local `prism-ml/Bonsai-4B-mlx-1bit` checkpoint through the MLX compatibility packing described in the [agent bridge verification](../AGENT_BRIDGE.md#bonsai-4b-coordinated-edit-probe). The native comparison used the actual provider tool protocol. Follow-up runs using a loopback envelope adapter are reported separately.

## Native comparison

| Metric | Mercury 3 | Bonsai 4B 1-bit |
| --- | ---: | ---: |
| Implementation, test and doc files delivered in both excerpts and file map | 3/3 | 0/3 |
| Required files read | 3/3 | 0/3 |
| Structured tool calls requested, including runtime discovery and command | 15 | 0 |
| Applied hunks / files | 6 / 3 | 0 / 0 |
| Time to first review | 19.72 s | — |
| Input / output tokens | 178,239 / 7,805 | 4,399 / 137 |
| Reported cached input tokens | 153,002 | 0 |
| Independent behavior cases passed | 15/15 | 6/15, unchanged baseline |
| Test collection | Syntax error in edited test file | Unchanged suite, 11 CLI tests passed |
| Documentation | Broken code fence and duplicated example | Unchanged |

Mercury's [first patch](mercury-first.patch) correctly validates the CLI option and preserves Python API behavior. It misplaced part of a test assertion and removed a closing Markdown fence during two end-of-file replacements. The CLI reached a test-command approval. The evaluator cancelled there after confirming the independent collection error. Bonsai ended in 20 seconds after producing a tool-call-shaped string. The native runtime dispatched zero tools. Its six passing oracle cases were present on the baseline.

Observed token totals are sums per provider call, so repeated prefixes count again. Cached input is the provider-reported subset. Approval time and provider/model tokenization prevent these figures from serving as a hardware-normalized throughput comparison. A model claiming to have read or changed a file does not affect scores.

## Mercury repair

A separate feedback-assisted turn told Mercury that the implementation passed the behavior oracle and gave it the independent test and docs diagnostics. It read the two affected files, staged two exact-range hunks, applied them through the CLI review gate, and completed `pytest -q tests/test_main.py` through the approved command tool. The [final patch](mercury-repaired.patch) changes exactly three files, with 46 additions and two deletions. It passed 15/15 independent oracle checks and all 13 CLI tests. The wider suite passed 1,418 tests with one skip. The pristine baseline passed 1,416 using the same configuration. Both excluded one Trio resource-warning failure reproduced on the pristine checkout. The new invalid-timeout test failed against the original implementation and passed with the model patch.

The repair took six provider calls and used 67,684 input tokens, including 52,314 reported cached input tokens, plus 3,945 output tokens. The 23.20 seconds to its first review exclude subsequent reviewer wait. This result measures recovery with explicit diagnostics.

## Bonsai compatibility follow-up

A loopback adapter normalized complete, recognized tool-call envelopes without filling in missing arguments or generating edits. The first follow-up dispatched one `assemble_context` call. Bonsai had supplied bare keywords as mentions. That exposed a Contexo bug where a generic word like “timeout” reserved implementation space for a Python client symbol. The model got 0/3 required file roles, guessed at out-of-scope client edits and exceeded the provider's 512-token output limit.

Contexo now treats bare mention strings as lexical hints. Explicit file paths and `@symbol` anchors still reserve evidence. The same Bonsai-generated context call then delivered 3/3 required files in the actual packet. Bonsai identified the correct CLI files in its response, then spent the 512 output tokens on prose and issued no read or write call. The checkout remained unchanged. [Per-run metrics and individual behavior outcomes](results.json)

## Reproduce the behavior score

From a clean HTTPX checkout at the pinned commit, run the oracle against the baseline and after applying either saved Mercury patch in a separate checkout. The oracle checks rejection of invalid values before the client or underlying socket starts, forwarding of default and valid positive values, and preservation of behavior in the Python client. Run the existing CLI tests separately to check collection and regressions.

```sh
PYTHONPATH="$PWD" python /path/to/model-comparison/oracle.py
python -m pytest -q tests/test_main.py
```
