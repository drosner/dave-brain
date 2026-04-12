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
  capture-orders.ts --from-gmail --window=24h --limit=50
