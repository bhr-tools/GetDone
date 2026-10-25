#!/bin/sh
# Runs the browser tests against a throwaway container of the current image.
# Screenshots go to tests/e2e/out. On Windows (Git Bash), run with
# MSYS_NO_PATHCONV=1 HOST_ROOT="$(pwd -W)" so Docker gets Windows paths.
set -eu
cd "$(dirname "$0")/../.."
HOST_ROOT="${HOST_ROOT:-$(pwd)}"
mkdir -p tests/e2e/out

docker compose build --quiet getdone
docker network create getdone-e2e >/dev/null 2>&1 || true
docker rm -f getdone-e2e >/dev/null 2>&1 || true
docker run -d --rm --name getdone-e2e --network getdone-e2e -e TZ=Europe/Paris getdone:latest >/dev/null
trap 'docker rm -f getdone-e2e >/dev/null 2>&1 || true' EXIT

docker run --rm --network getdone-e2e --ipc=host \
  -v "$HOST_ROOT/tests/e2e:/tests" -e OUT=/tests/out \
  mcr.microsoft.com/playwright/python:v1.49.0-jammy \
  sh -c "pip install -q playwright==1.49.0 2>/dev/null; python /tests/smoke.py"
