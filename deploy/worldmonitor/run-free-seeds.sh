#!/bin/sh
set -eu
exec 9>/run/worldmonitor-seeds.lock
flock -n 9 || exit 0
docker run --rm --network host --memory 512m --cpus 0.5 --env-file /opt/worldmonitor-host/seed.env --entrypoint sh worldmonitor:seeders -c '
for script in seed-earthquakes seed-weather-alerts seed-military-bases seed-prediction-markets seed-market-quotes; do
  echo "Refreshing $script"
  timeout 90 node "scripts/$script.mjs" || echo "Source unavailable: $script"
done
'
