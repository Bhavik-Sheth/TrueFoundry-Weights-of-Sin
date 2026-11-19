#!/usr/bin/env bash
# setup-flask.sh
# PURPOSE: Prepare the demo target repository on macOS/Linux. Counterpart of setup-flask.ps1.
# STEPS (to implement):
#   1. Clone pallets/flask at tag 3.1.3 (commit 22d92470) into a sibling "flask" folder; skip if present.
#   2. Create a Python venv (.venv) inside it.
#   3. pip install -e . plus test deps (pytest, etc.).
#   4. Print the activation command and how to run `pytest tests/test_cli.py -q`.
# Used by: README clean-clone setup.
