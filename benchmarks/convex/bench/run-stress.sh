#!/bin/bash
# run-stress.sh <convex|onebase> — full 5-mode stress round with resource sampling
# Convex needs CONVEX_ADMIN_KEY. Both containers must be up: docker stats prints
# nothing at all if either one is missing.
P=$1
cd "$(dirname "$0")" || exit 1
if [ "$P" = "convex" ]; then
  export CONVEX_ADMIN_KEY=${CONVEX_ADMIN_KEY:?set CONVEX_ADMIN_KEY}
  export CONVEX_URL=${CONVEX_URL:-http://127.0.0.1:3210}
  SEED='{"path":"bench:writeDocs","args":{"n":2000,"size":10}}'
  CLEAR='{"path":"bench:clearDocs","args":{"limit":2000}}'
  URL=$CONVEX_URL
elif [ "$P" = "onebase" ]; then
  unset CONVEX_ADMIN_KEY
  export ONEBASE_URL=${ONEBASE_URL:-http://127.0.0.1:8190}
  SEED='{"path":"bench:writeDocs","args":{"n":2000,"size":10}}'
  CLEAR='{"path":"bench:clearDocs","args":{"limit":50000}}'
  URL=$ONEBASE_URL
else
  echo "usage: ./run-stress.sh <convex|onebase>" >&2
  exit 1
fi

for C in convex-backend-1 onebase-bench; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$C" 2>/dev/null)" != "true" ]; then
    echo "container $C isn't running (see README.md)" >&2
    exit 1
  fi
done

# baseline (idle) sample
./sample-stats.sh r_${P}_idle.csv 8 convex-backend-1 onebase-bench

# seed table for scan
curl -s -X POST "$URL/api/mutation" -H 'Content-Type: application/json' \
  ${CONVEX_ADMIN_KEY:+-H "Authorization: Convex $CONVEX_ADMIN_KEY"} -d "$SEED" >/dev/null

MODES="${MODES:-ping:300 scan:100 write:100 bigdoc:50 mixed:150}"
for M in $MODES; do
  MODE=${M%%:*}; C=${M##*:}
  ./sample-stats.sh r_${P}_${MODE}.csv 72 convex-backend-1 onebase-bench &
  S=$!
  node stress.mjs $P $MODE 60 $C
  wait $S
done

curl -s -X POST "$URL/api/mutation" -H 'Content-Type: application/json' \
  ${CONVEX_ADMIN_KEY:+-H "Authorization: Convex $CONVEX_ADMIN_KEY"} -d "$CLEAR" >/dev/null

echo "DONE_STRESS_$P"
