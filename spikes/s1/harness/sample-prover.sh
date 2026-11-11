#!/bin/sh
# Samples the prover container's memory and CPU once a second while a proof runs.
#   ./sample-prover.sh [output.csv]     stop with Ctrl-C; prints the peak on exit
# Phase timings come from the prover's own log:  docker logs -f social-prover-1
OUT=${1:-prover-samples-$(date +%Y%m%d-%H%M%S).csv}
NAME=$(docker ps --filter "name=prover" --format '{{.Names}}' | head -1)
[ -z "$NAME" ] && { echo "no running prover container (start it with: bun run service:prover)"; exit 1; }
echo "sampling $NAME into $OUT"
echo "unix_time,mem_usage,cpu_percent" > "$OUT"
trap 'echo; echo "peak memory:"; cut -d, -f2 "$OUT" | grep -E "GiB|MiB" | sort -h | tail -1; exit 0' INT
while :; do
  docker stats --no-stream --format '{{.MemUsage}},{{.CPUPerc}}' "$NAME" | sed 's# / [^,]*##' | sed "s/^/$(date +%s),/" >> "$OUT"
  sleep 1
done
