#!/bin/sh
# The container's command: the daemon through the start.sh setup wrote, or nothing before setup.
set -eu
start=/home/mama/.mama/start.sh
if [ ! -x "$start" ]; then
  echo "MAMA is not set up in this volume yet: run docker compose run --rm mama init, then docker compose up -d" >&2
  # Exit 0 so restart: on-failure leaves the container stopped instead of looping.
  exit 0
fi
exec "$start"
