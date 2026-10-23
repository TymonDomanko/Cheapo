#!/bin/sh
# Volumes mounted by Docker, Fly.io, Render etc. are often owned by root.
# Make the data directory writable, then run the app as an unprivileged user:
# the image's "node" user, or PUID/PGID if set (e.g. PUID=99 PGID=100 on Unraid,
# so files in your share stay owned by nobody:users).
# With LITESTREAM_BUCKET set, the database is restored from cloud storage on a
# fresh disk and every change is streamed back to it while the app runs.
set -e
DATA_DIR="${DATA_DIR:-/data}"
export DB_PATH="${DB_PATH:-$DATA_DIR/supermarket.db}"

if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-$(id -u node)}"
  PGID="${PGID:-$(id -g node)}"
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR"
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$0" "$@"
fi

if [ -n "$LITESTREAM_BUCKET" ]; then
  export LITESTREAM_PATH="${LITESTREAM_PATH:-grocery}"
  export LITESTREAM_REGION="${LITESTREAM_REGION:-auto}"
  if [ ! -f "$DB_PATH" ]; then
    echo "No database on disk: restoring the latest copy from cloud storage (if there is one)…"
    litestream restore -config /etc/litestream.yml -if-replica-exists "$DB_PATH"
  fi
  exec litestream replicate -config /etc/litestream.yml -exec "$*"
fi
exec "$@"
