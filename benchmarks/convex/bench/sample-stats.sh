#!/bin/bash
# sample-stats.sh <out.csv> <seconds> <container> [container...]
OUT=$1; DUR=$2; shift 2
echo "ts,name,cpu,mem" > "$OUT"
END=$((SECONDS + DUR))
while [ $SECONDS -lt $END ]; do
  TS=$(date +%s)
  docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}}" "$@" \
    | while IFS= read -r line; do echo "$TS,$line"; done >> "$OUT"
done
