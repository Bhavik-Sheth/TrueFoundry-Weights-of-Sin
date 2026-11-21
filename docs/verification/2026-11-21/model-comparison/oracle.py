import json
from unittest.mock import patch

import httpx
from click.testing import CliRunner
from httpx._main import main

results = {}

def probe(label, args, expected_timeout=None):
    with patch("httpx._main.Client") as client, patch("socket.socket.connect") as connect:
        client.return_value.__enter__.return_value.stream.return_value.__enter__.return_value = httpx.Response(204)
        result = CliRunner().invoke(main, ["http://127.0.0.1", *args])
        if expected_timeout is None:
            passed = result.exit_code == 2 and not client.called and not connect.called and bool(result.output.strip())
        else:
            passed = (result.exit_code == 0 and client.called
                      and client.call_args.kwargs.get("timeout") == expected_timeout)
        results[label] = {"passed": passed, "exit": result.exit_code, "client_started": client.called}

for value in ("0", "-0", "-1", "NaN", "inf", "-inf", "+Infinity", "1e999", "1e-999", "oops"):
    probe("reject " + value, [f"--timeout={value}"])
for label, args, timeout in (
    ("default", [], 5.0), ("fraction", ["--timeout", "1.25"], 1.25),
    ("integer", ["--timeout=2"], 2.0), ("scientific", ["--timeout=1e-3"], 0.001),
):
    probe(label, args, timeout)
with httpx.Client(timeout=0) as client:
    results["Python Client still accepts zero timeout"] = {"passed": client.timeout.connect == 0}
print(json.dumps({"passed": sum(item["passed"] for item in results.values()),
                  "total": len(results), "cases": results}, indent=2))
raise SystemExit(0 if all(item["passed"] for item in results.values()) else 1)
