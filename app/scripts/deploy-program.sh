#!/usr/bin/env bash
# Wrapper around `solana program deploy` that backs off when devnet
# returns 429. Each failed attempt closes orphan buffer accounts before
# the next try, so we don't drain the admin keypair across retries.
set -euo pipefail

SO=${1:-../target/deploy/moonex.so}
KP=${2:-../target/deploy/moonex-keypair.json}
LOG=/tmp/moonex-deploy.log

# Resolve to absolute paths so subsequent cd's don't break things.
SO=$(cd "$(dirname "$SO")" && pwd)/$(basename "$SO")
KP=$(cd "$(dirname "$KP")" && pwd)/$(basename "$KP")

attempt=0
wait_s=60
max_wait=600
max_attempts=${MAX_ATTEMPTS:-1000}

while true; do
  attempt=$((attempt + 1))
  echo "[deploy] attempt $attempt"

  if solana program deploy "$SO" --program-id "$KP" --use-rpc --max-sign-attempts 1000 2>&1 | tee "$LOG" | grep -qE "^Signature:"; then
    echo "[deploy] success"
    exit 0
  fi

  # Reclaim any leaked buffer from this failed attempt.
  buf=$(grep -oE 'solana program close [A-Za-z0-9]+' "$LOG" | tail -1 | awk '{print $4}' || true)
  if [ -n "${buf:-}" ]; then
    echo "[deploy] closing orphan buffer $buf"
    solana program close "$buf" --bypass-warning >/dev/null 2>&1 || true
  fi

  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "[deploy] giving up after $attempt attempts"
    exit 1
  fi

  echo "[deploy] 429 / failure — sleeping ${wait_s}s before retry"
  sleep "$wait_s"
  wait_s=$(( wait_s * 2 ))
  if [ "$wait_s" -gt "$max_wait" ]; then wait_s=$max_wait; fi
done
