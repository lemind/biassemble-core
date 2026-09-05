#!/bin/bash
SK=$(grep -m1 '^INNGEST_SIGNING_KEY=' .env | cut -d= -f2- | tr -d '"')
for i in $(seq 1 30); do
  ST=$(curl -s -H "Authorization: Bearer $SK" "https://api.inngest.com/v1/events/01M1PVZAF1HH8BP5FF6GXVSQZZ/runs" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d[0]['status'] if d else 'none')" 2>/dev/null)
  echo "=== $(date +%H:%M:%S) $ST"
  case "$ST" in Completed|Failed|Cancelled)
    curl -s -H "Authorization: Bearer $SK" "https://api.inngest.com/v1/events/01M1PVZAF1HH8BP5FF6GXVSQZZ/runs" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data'][0]
o=d.get('output')
if isinstance(o,dict) and 'error' in o: print('ERROR:', o['error'].get('message','')[:1200])
else: print(json.dumps(o, indent=1)[:3000])
"
    echo "RUN-$ST"; break;;
  esac
  sleep 45
done
