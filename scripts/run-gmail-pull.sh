#!/bin/bash
cd "$(dirname "$0")"
mkdir -p logs
LOGFILE="logs/pull-gmail-$(date +%Y%m%d-%H%M%S).log"
echo "Logging to: $LOGFILE"
deno run --allow-net --allow-read --allow-write --allow-env --env-file=.env pull-gmail.ts "$@" 2>&1 | tee "$LOGFILE"      