#!/bin/sh
# Local/CI bootstrap (ADR 0001 §4.3). Runs once, as the Docker superuser, on an empty data volume.
#   recallio_migrator  owns the databases and every object in them; runs migrations (DDL)
#   recallio_app       runtime role: CONNECT + the DML grants from migration 0004, nothing else
# Passwords are read inside psql with \getenv and bound as psql variables: never interpolated by the
# shell, never on a command line, never echoed.
set -eu

: "${RECALLIO_MIGRATOR_PASSWORD:?RECALLIO_MIGRATOR_PASSWORD is not set}"
: "${RECALLIO_APP_PASSWORD:?RECALLIO_APP_PASSWORD is not set}"
export RECALLIO_DB="$POSTGRES_DB"

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv migrator_pw RECALLIO_MIGRATOR_PASSWORD
\getenv app_pw RECALLIO_APP_PASSWORD
\getenv db RECALLIO_DB

CREATE ROLE recallio_migrator LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS
  PASSWORD :'migrator_pw';
CREATE ROLE recallio_app LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS NOINHERIT
  PASSWORD :'app_pw';

ALTER DATABASE :"db" OWNER TO recallio_migrator;
CREATE DATABASE recallio_test OWNER recallio_migrator;

-- Removes the default CONNECT and TEMP from PUBLIC. The app role gets CONNECT only.
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO recallio_app;
REVOKE ALL ON DATABASE recallio_test FROM PUBLIC;
GRANT CONNECT ON DATABASE recallio_test TO recallio_app;
SQL
