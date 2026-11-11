#!/bin/sh
set -eu
cd /opt/worldmonitor
case "${SSH_ORIGINAL_COMMAND:-deploy}" in
  deploy)
    previous=$(docker inspect --format '{{.Image}}' worldmonitor 2>/dev/null || true)
    if [ -n "$previous" ]; then docker tag "$previous" worldmonitor:previous; fi
    docker-compose up -d --no-build
    ;;
  rollback)
    docker image inspect worldmonitor:previous >/dev/null
    docker tag worldmonitor:previous worldmonitor:local-api
    docker-compose up -d --no-build
    ;;
  *) echo 'Command not permitted'; exit 1 ;;
esac
curl -fsS --retry 10 --retry-delay 3 --retry-connrefused http://192.168.1.237:3000/ -o /dev/null
printf 'World Monitor service ready\n'
