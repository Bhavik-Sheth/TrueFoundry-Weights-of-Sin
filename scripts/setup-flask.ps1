# setup-flask.ps1
# PURPOSE: Prepare the demo target repository on Windows (PowerShell).
# Usage: powershell -File scripts/setup-flask.ps1 [-Target <dir>]
# STEPS:
#   1. Clone pallets/flask at tag 3.1.3 into the target (default: sibling "flask" of the repo root); skip if present.
#   2. Create a Python venv (.venv) inside it.
#   3. pip install -e . plus test deps (requirements/tests.txt if present at the tag, else pytest).
#   4. Print the activation command and how to run `pytest tests/test_cli.py -q`.
# Used by: README clean-clone setup. Counterpart: scripts/setup-flask.sh.
# No secrets are written.
param([string]$Target = "")
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Target) { $Target = Join-Path (Split-Path -Parent $repoRoot) "flask" }
$Tag = "3.1.3"

if (-not (Test-Path (Join-Path $Target ".git"))) {
  git clone https://github.com/pallets/flask $Target
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
} else { Write-Host "Flask already cloned at $Target" }

git -C $Target checkout --quiet $Tag
if ($LASTEXITCODE -ne 0) { throw "git checkout $Tag failed" }

$venv = Join-Path $Target ".venv"
if (-not (Test-Path $venv)) {
  python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw "venv creation failed" }
}
$py = Join-Path $venv "Scripts\python.exe"
& $py -m pip install --quiet --upgrade pip
$req = Join-Path $Target "requirements\tests.txt"
& $py -m pip install --quiet -e $Target
if ($LASTEXITCODE -ne 0) { throw "pip install -e failed" }
$ok = $false
if (Test-Path $req) {
  & $py -m pip install --quiet -r $req
  if ($LASTEXITCODE -eq 0) { $ok = $true } else { Write-Host "Pinned test requirements failed; falling back to pytest only" }
}
if (-not $ok) {
  & $py -m pip install --quiet pytest
  if ($LASTEXITCODE -ne 0) { throw "pip install pytest failed" }
}
# Flask 3.1.3's tests import _pytest.monkeypatch.notset, removed in pytest 9
& $py -m pip install --quiet "pytest<9"
if ($LASTEXITCODE -ne 0) { throw "pip install pytest<9 failed" }

# the venv must not show up as untracked in the demo repo
$exclude = Join-Path $Target ".git\info\exclude"
if (-not (Select-String -Path $exclude -Pattern '^\.venv/?$' -Quiet)) { Add-Content $exclude ".venv/" }

Write-Host "Flask $Tag ready at $Target"
Write-Host "Activate: $venv\Scripts\Activate.ps1"
Write-Host "Test:     $py -m pytest tests/test_cli.py -q   (run from $Target)"
