#!/bin/sh
# Browser tests with Playwright from nixpkgs: builds the server, starts it on a
# throwaway database and drives the app with Chromium.
# Screenshots go to tests/e2e/out.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p tests/e2e/out
work=$(mktemp -d)
trap 'kill $pid 2>/dev/null || true; rm -rf "$work"' EXIT

nix shell nixpkgs#go --command go build -o "$work/getdone" ./cmd/server
PORT=${PORT:-18080}
TZ=Europe/Paris "$work/getdone" -port "$PORT" -data-dir "$work/data" >"$work/server.log" 2>&1 &
pid=$!

nix-shell -p 'python3.withPackages (ps: [ ps.playwright ])' --run "
  export PLAYWRIGHT_BROWSERS_PATH=$(nix build --no-link --print-out-paths nixpkgs#playwright-driver.browsers)
  export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
  BASE_URL=http://127.0.0.1:$PORT OUT=tests/e2e/out TZ=Europe/Paris python3 tests/e2e/smoke.py
"
