#!/bin/sh
set -eu
cd /opt/openradio-host
case "${SSH_ORIGINAL_COMMAND:-deploy}" in
  deploy)
    previous=$(docker inspect --format '{{.Image}}' openradio 2>/dev/null || true)
    if [ -n "$previous" ]; then docker tag "$previous" openradio:previous; fi
    docker-compose up -d --no-build
    ;;
  rollback)
    docker image inspect openradio:previous >/dev/null
    docker tag openradio:previous openradio:local
    docker-compose up -d --no-build
    ;;
  *) echo 'Command not permitted'; exit 1 ;;
esac
curl -fsS --retry 10 --retry-delay 3 --retry-connrefused http://192.168.1.237:3100/ -o /dev/null
printf 'OpenRadio service ready\n'
