#!/bin/sh
# Patch Next.js internal proxy timeout 30000ms -> 600000ms for long-running MCP calls.
# Mirrors the sed step the Dockerfile applies at build time. Idempotent.
# Run AFTER `pnpm install`, BEFORE starting the frontend. Safe to re-run after every install.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

patched=0
skipped=0
found=0

# Match both the CJS and ESM copies under the pnpm next package.
for f in $(find node_modules/.pnpm -type f -path '*next@*/node_modules/next/dist/*/server/lib/router-utils/proxy-request.js' 2>/dev/null) \
         $(find node_modules/.pnpm -type f -path '*next@*/node_modules/next/dist/server/lib/router-utils/proxy-request.js' 2>/dev/null); do
    found=$((found + 1))
    if grep -q '600000' "$f"; then
        echo "skip (already 600000): $f"
        skipped=$((skipped + 1))
        continue
    fi
    if grep -q '30000' "$f"; then
        sed -i.bak 's/30000/600000/g' "$f"
        echo "patched 30000->600000: $f"
        patched=$((patched + 1))
    else
        echo "note (no 30000 token found): $f"
    fi
done

if [ "$found" -eq 0 ]; then
    echo "WARNING: no Next.js proxy-request.js found under node_modules/.pnpm — run after 'pnpm install'." >&2
    exit 1
fi

echo "Done. patched=$patched skipped=$skipped found=$found"
