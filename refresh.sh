#!/bin/bash
# Daily: re-read the YouTube upload feeds and push. Vercel redeploys on push.
# Run by ~/Library/LaunchAgents/com.claudeclaw.ai-tube-radar.plist
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
cd /Users/jack/Projects/ai-tube-radar

npx tsx fetch.ts

# `generated` moves every run, so there is always something to commit. That is fine:
# the page shows a "data age" stat, so a daily commit keeps it honest.
git commit -qm "refresh feeds $(date '+%F')" -- data.json
git push -q origin main
echo "$(date '+%F %T') pushed"
