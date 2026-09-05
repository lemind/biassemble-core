#!/bin/bash
SK=$(grep -m1 '^INNGEST_SIGNING_KEY=' .env | cut -d= -f2- | tr -d '"')
for i in $(seq 1 20); do
  ST=$(curl -s -H "Authorization: Bearer $SK" "https://api.inngest.com/v1/events/01M1R200X9M3TM38JRWH6KR4YC/runs" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d[0]['status'] if d else 'none')" 2>/dev/null)
  echo "=== $(date +%H:%M:%S) $ST"
  case "$ST" in Completed|Failed|Cancelled) echo "RUN-$ST"; break;; esac
  sleep 30
done
