#!/usr/bin/env bash
#
# Bring up identity for the first time.
#
# The only thing this generates is the pair of MySQL passwords, because a
# database container cannot ask a browser for them the way the rest of the
# configuration is collected. Everything else — the NocoDB address, the API
# token, the trusted network, the OAuth credentials — is typed into /setup
# once this is running.
#
# Safe to re-run: existing values in .env are never overwritten.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=.env
[ -f "$ENV_FILE" ] || : > "$ENV_FILE"

# A generated secret goes in only if the name is not already spoken for —
# re-running must never orphan the data directory from its own password.
ensure_secret() {
  local key=$1
  if grep -qE "^${key}=.+" "$ENV_FILE"; then
    echo "  $key already set — keeping it"
    return
  fi
  # Drop a blank definition if one is sitting there, then append.
  sed -i "/^${key}=\s*$/d" "$ENV_FILE"
  printf '%s=%s\n' "$key" "$(openssl rand -hex 24)" >> "$ENV_FILE"
  echo "  $key generated"
}

echo "Generating database credentials in $ENV_FILE:"
ensure_secret MYSQL_ROOT_PASSWORD
ensure_secret DB_PASSWORD
chmod 600 "$ENV_FILE"

# The reverse proxy's network is external to this project, so it has to
# exist before compose can join it. Creating it is harmless if it is
# already there, and means a standalone install works with no proxy at all.
if ! docker network inspect npm_network >/dev/null 2>&1; then
  echo "Creating the npm_network bridge (no reverse proxy found)"
  docker network create npm_network >/dev/null
fi

echo "Starting identity and its database…"
docker compose up -d --build

cat <<'DONE'

Up. Open this service in a browser to finish setting it up:

  /setup  asks for the NocoDB URL, an API token, and the trusted network,
          then restarts itself and asks for your Google or Microsoft OAuth
          client credentials.

The first person to complete that wizard becomes Super System Admin, so do
it now if this service is reachable from the internet.
DONE
