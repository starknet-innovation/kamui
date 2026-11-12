#!/bin/sh
# Runs only on a new PGDATA. Application owns its database/schema, not the server.
set -eu
set +x
[ -s "${APP_PASSWORD_FILE:?}" ] || { printf '%s\n' 'APP_DATABASE_PASSWORD_REQUIRED' >&2; exit 1; }
APP_DATABASE_PASSWORD=$(cat "$APP_PASSWORD_FILE")
export APP_DATABASE_PASSWORD
psql --username postgres --dbname kamui --no-psqlrc --set ON_ERROR_STOP=1 <<'SQL'
\getenv app_password APP_DATABASE_PASSWORD
CREATE ROLE kamui LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
ALTER DATABASE kamui OWNER TO kamui;
ALTER SCHEMA public OWNER TO kamui;
SQL
unset APP_DATABASE_PASSWORD
