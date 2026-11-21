#!/usr/bin/env bash
# Run Contexo against three pinned public upstream checkouts. Edits stay in the temporary copies.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
lab="$(mktemp -d)"
trap 'rm -rf "$lab"' EXIT

clone() {
  git -c advice.detachedHead=false clone -q --depth=1 --branch "$2" "$1" "$lab/$3"
  test "$(git -C "$lab/$3" rev-parse HEAD)" = "$4"
}

clone https://github.com/pallets/flask.git 3.1.3 flask 22d924701a6ae2e4cd01e9a15bbaf3946094af65
clone https://github.com/golang/sync.git v0.10.0 sync 913fb63af28f446cd10c684ee847b5606cf328f7
clone https://github.com/BurntSushi/ripgrep.git 14.1.1 ripgrep 4649aa9700619f94cf9c66876e9549d83420e16c

cd "$root/extension"
ln -s "$PWD/node_modules" "$lab/node_modules"
ln -s "$PWD/dist/web-tree-sitter.wasm" "$lab/web-tree-sitter.wasm"
ln -s "$PWD/dist/tree-sitter-python.wasm" "$lab/tree-sitter-python.wasm"
node_modules/.bin/esbuild test/host/ossProbe.ts --bundle --platform=node --packages=external --outfile="$lab/probe.cjs"
node "$lab/probe.cjs" "$lab"
