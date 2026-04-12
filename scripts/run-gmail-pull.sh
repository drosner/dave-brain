#!/bin/bash
set -a
source /home/drosner/davebrain/.env
set +a

cd /home/drosner/davebrain

deno run \
  --allow-net \
  --allow-read \
  --allow-write \
  --allow-env \
  pull-gmail.ts --window=24h --labels=INBOX,SENT --limit=200
