#!/usr/bin/env bash
#
# Create or update the MySQL account Identity connects as, on a shared MySQL.
# Idempotent: every run converges the grants, and a new password rotates it.
#
#   identity   ALL PRIVILEGES on its own database (platform_db), because
#              Identity applies its own schema at boot (src/migrations.ts).
#
# The standalone install (scripts/install.sh + compose.dev.yaml) doesn't
# need this: its private MySQL creates the same account with the same rights
# from MYSQL_USER when the volume is first initialised.
#
# Run by an environment's operator with MySQL admin credentials, passing the
# same DB_* values Identity itself reads (PlatformConfig rows or environment):
#
#   docker run --rm --network <network> -v "$PWD/scripts:/scripts:ro" \
#     -e DB_HOST=<mysql host> -e DB_PASSWORD=… -e MYSQL_ADMIN_PASSWORD=… \
#     mysql:8.4 bash /scripts/db-users.sh
#
# The account is created for any host ('%'): which networks can reach MySQL
# is the environment's decision, not something to pin here.

set -euo pipefail

HOST="${DB_HOST:?DB_HOST: the MySQL host}"
PORT="${DB_PORT:-3306}"
DB="${DB_NAME:-platform_db}"
USER_NAME="${DB_USER:-identity}"
: "${DB_PASSWORD:?DB_PASSWORD: the password Identity connects with}"
ADMIN="${MYSQL_ADMIN_USER:-root}"
: "${MYSQL_ADMIN_PASSWORD:?MYSQL_ADMIN_PASSWORD: password for $ADMIN}"

die() { echo "[db-users] $*" >&2; exit 2; }
# Names are interpolated into SQL, so they must be plain identifiers.
name() { [[ $1 =~ ^[A-Za-z0-9_]+$ ]] || die "not a plain identifier: $1"; printf '%s' "$1"; }
# A SQL string literal: backslashes and quotes escaped for the default sql_mode.
literal() { local s=${1//\\/\\\\}; printf "'%s'" "${s//\'/\'\'}"; }

DB=$(name "$DB"); USER_NAME=$(name "$USER_NAME")
who="'$USER_NAME'@'%'"
# In a database-level GRANT, _ and % are wildcards: escape them so the grant
# names exactly this database (platform\_db), as MySQL's own initdb does.
DB_GRANT=${DB//_/\\_}

# MYSQL_PWD keeps the admin password out of the process list; the SQL itself,
# including the account password, goes over stdin.
MYSQL_PWD="$MYSQL_ADMIN_PASSWORD" command mysql --protocol=TCP -h "$HOST" -P "$PORT" \
  -u "$ADMIN" --batch --skip-column-names <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB\`;
CREATE USER IF NOT EXISTS $who IDENTIFIED BY $(literal "$DB_PASSWORD");
ALTER USER $who IDENTIFIED BY $(literal "$DB_PASSWORD");
REVOKE ALL PRIVILEGES, GRANT OPTION FROM $who;
GRANT ALL PRIVILEGES ON \`$DB_GRANT\`.* TO $who;
SQL

echo "[db-users] $USER_NAME: ALL PRIVILEGES on $DB"
