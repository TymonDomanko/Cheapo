#!/bin/sh
# Volumes mounted by Docker, Fly.io, Render etc. are often owned by root.
# Make the data directory writable, then run the app as the unprivileged "node" user.
set -e
DATA_DIR="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
