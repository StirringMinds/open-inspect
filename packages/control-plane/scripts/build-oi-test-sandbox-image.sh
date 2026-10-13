#!/usr/bin/env bash
# Build + push the Cloudflare sandbox image (Python sandbox-runtime, Modal target layout).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUT="$(mktemp -d)"
python3 "$ROOT/packages/sandbox-images/cli.py" pack --provider modal --output "$OUT"
CTX="$(ls -d "$OUT"/modal-*)"
cp "$ROOT/packages/sandbox-images/Dockerfile" "$CTX/"
docker build --platform linux/amd64 -t oi-test-sandbox:py "$CTX"
npx wrangler containers push oi-test-sandbox:py
echo "Update the image digest in packages/control-plane/wrangler.oi-test.jsonc"
