#!/bin/sh
set -eu
umask 077
mkdir -p /app/var/data
node node_modules/prisma/build/index.js migrate deploy
exec "$@"
