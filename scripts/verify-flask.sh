#!/usr/bin/env bash
# Verify three separate Flask checkouts after completing A, B and C.
set -euo pipefail
if [ "$#" -ne 3 ]; then echo "Usage: PYTHON=/path/to/venv/bin/python $0 A_CHECKOUT B_CHECKOUT C_CHECKOUT" >&2; exit 2; fi
python=$(command -v "${PYTHON:-python3}")
expected=22d924701a6ae2e4cd01e9a15bbaf3946094af65
for root in "$@"; do
  [[ "$(git -C "$root" rev-parse HEAD)" == "$expected" ]] || { echo "Expected Flask 3.1.3 at $root" >&2; exit 1; }
done
(
  cd "$1"; export PYTHONPATH="$PWD/src"
  [[ "$(git diff --name-only HEAD)" == src/flask/helpers.py ]]
  FLASK_DEBUG=off "$python" -c 'from flask.helpers import get_debug_flag; print(get_debug_flag()); assert get_debug_flag() is False'
  "$python" - <<'PY'
import os
from flask.helpers import get_debug_flag
for value in ("0", "FALSE", "no", "Off", "N", ""):
    os.environ["FLASK_DEBUG"] = value
    assert not get_debug_flag(), value
os.environ["FLASK_DEBUG"] = "1"
assert get_debug_flag()
PY
)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cat >"$fixture/verify_app.py" <<'PY'
from flask import Flask
app = Flask(__name__)
app.config.update(SECRET_SAMPLE="demo", DB_PASSWORD="demo", ACCESS_TOKEN="demo", PRIVATE_KEY="demo", PUBLIC_VALUE="visible")
PY
(
  cd "$2"; export PYTHONPATH="$PWD/src"
  [[ "$(git diff --name-only HEAD | wc -l)" -ge 3 ]]
  "$python" -m pytest tests/test_cli.py -q
  "$python" -m flask --app "$fixture/verify_app.py" --help > "$fixture/help"
  grep -E '^  config([[:space:]]|$)' "$fixture/help"
  "$python" -m flask --app "$fixture/verify_app.py" config > "$fixture/config.json"
  "$python" - "$fixture/config.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for key in ("SECRET_SAMPLE", "DB_PASSWORD", "ACCESS_TOKEN", "PRIVATE_KEY"):
    assert data[key] == "***", key
assert data["PUBLIC_VALUE"] == "visible"
print(json.dumps({key: data[key] for key in ("SECRET_SAMPLE","DB_PASSWORD","ACCESS_TOKEN","PRIVATE_KEY","PUBLIC_VALUE")}, indent=2))
PY
)
changes=$(git -C "$3" status --porcelain)
[[ -z "$changes" ]] || { echo "$changes" >&2; exit 1; }
echo 'Task C checkout clean. Verify the error and editor responsiveness in the session recording.'
