#!/usr/bin/env bash
# setup-flask.sh
# PURPOSE: Prepare the demo target repository on macOS/Linux. Counterpart of setup-flask.ps1.
# Usage: scripts/setup-flask.sh [target-dir]
# STEPS:
#   1. Clone pallets/flask at tag 3.1.3 into the target (default: sibling "flask" of the repo root); skip if present.
#   2. Create a Python venv (.venv) inside it.
#   3. pip install -e . plus test deps (requirements/tests.txt if present at the tag, else pytest).
#   4. Print the activation command and how to run `pytest tests/test_cli.py -q`.
# Used by: README clean-clone setup.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$(dirname "$REPO_ROOT")/flask}"
TAG="3.1.3"

if [ ! -d "$TARGET/.git" ]; then
  git clone https://github.com/pallets/flask "$TARGET"
else
  echo "Flask already cloned at $TARGET"
fi
git -C "$TARGET" checkout --quiet "$TAG"

[ -d "$TARGET/.venv" ] || python3 -m venv "$TARGET/.venv"
PY="$TARGET/.venv/bin/python"
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet -e "$TARGET"
if [ -f "$TARGET/requirements/tests.txt" ] && "$PY" -m pip install --quiet -r "$TARGET/requirements/tests.txt"; then :; else
  echo "Falling back to pytest only"
  "$PY" -m pip install --quiet pytest
fi
# Flask 3.1.3's tests import _pytest.monkeypatch.notset, removed in pytest 9
"$PY" -m pip install --quiet "pytest<9"

grep -qx '\.venv/' "$TARGET/.git/info/exclude" || echo '.venv/' >> "$TARGET/.git/info/exclude"

echo "Flask $TAG ready at $TARGET"
echo "Activate: source $TARGET/.venv/bin/activate"
echo "Test:     (cd $TARGET && .venv/bin/python -m pytest tests/test_cli.py -q)"
